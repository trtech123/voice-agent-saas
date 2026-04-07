// voiceagent-saas/janitor.js
//
// Janitor — periodic sweeps for stuck calls, orphaned audio-archive jobs,
// and old webhook events. Part of Spec A (ElevenLabs runtime swap), task T8.
//
// Public interface:
//   startJanitor({ supabase, audioArchiveQueue, logger })
//   stopJanitor() -> Promise<void>
//
// The janitor runs every 60s. Each sweep is wrapped in its own try/catch
// so a single failing sweep cannot block the others, and the top-level
// runOnce() swallows all errors — the janitor MUST NEVER crash the host
// process.
//
// NOTE ON MODULE SYSTEM: despite the T8 spec calling for CommonJS, the
// rest of voiceagent-saas/ is ESM (package.json "type":"module",
// server.js + call-processor.js use `import`). We match the local
// convention over the spec text.

// ─── Module-level state (single instance per process) ─────────────

let timerHandle = null;
let running = false;
let stopping = false;

const SWEEP_INTERVAL_MS = 60_000;
const STUCK_CALL_AGE_MINUTES = 15;
const ORPHAN_ARCHIVE_AGE_MINUTES = 10;
const WEBHOOK_EVENTS_TTL_DAYS = 30;
const BATCH_LIMIT = 50;

// ─── Sweep 1: Stuck calls ─────────────────────────────────────────
//
// Finalizes any `calls` row whose started_at is older than 15 minutes
// but ended_at is still NULL. These are calls that crashed mid-flight
// (e.g. `kill -9` mid-call — verification gate G12).
//
// TRADE-OFF: the spec's ideal shape is a single Postgres transaction
//   SELECT ... FOR UPDATE SKIP LOCKED;
//   UPDATE ... WHERE id = $1;
// but @supabase/supabase-js over PostgREST can't run multi-statement
// transactions. We do a plain SELECT followed by per-row UPDATE and
// accept the small race window. On the current single-droplet deploy
// only one janitor instance exists, so there is no contention.
// TODO: switch to postgres-js once SUPABASE_DIRECT_DB_URL is wired in
// via T5 live-turn-writer / T13 server wiring.

async function sweepStuckCalls(supabase, log) {
  const cutoffIso = new Date(Date.now() - STUCK_CALL_AGE_MINUTES * 60_000).toISOString();

  const { data: stuckRows, error: selectErr } = await supabase
    .from("calls")
    .select("id, tenant_id, started_at")
    .lt("started_at", cutoffIso)
    .is("ended_at", null)
    .order("started_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (selectErr) {
    log.error({ err: selectErr }, "sweepStuckCalls: select failed");
    return;
  }
  if (!stuckRows || stuckRows.length === 0) return;

  for (const row of stuckRows) {
    try {
      const nowIso = new Date().toISOString();
      const ageSeconds = Math.max(
        0,
        Math.round((Date.now() - new Date(row.started_at).getTime()) / 1000),
      );

      // Dual-write both columns: `failure_reason` (legacy text) is still
      // read by tab-failed.tsx / dashboard.ts, and `failure_reason_t` is
      // the new enum used by Spec A metrics. Back-compat until readers
      // are migrated to the enum.
      const { error: updateErr } = await supabase
        .from("calls")
        .update({
          ended_at: nowIso,
          failure_reason: "janitor_finalized",
          failure_reason_t: "janitor_finalized",
        })
        .eq("id", row.id)
        .is("ended_at", null); // guard against races with call-bridge

      if (updateErr) {
        log.error(
          { err: updateErr, call_id: row.id },
          "sweepStuckCalls: update failed",
        );
        continue;
      }

      // Insert a minimal call_metrics row. call_metrics.call_id is PK,
      // so if call-bridge already wrote one we no-op via ON CONFLICT.
      // Only duration is filled; richer metric fields (tts_first_byte_ms,
      // el_ws_open_ms, ...) are the responsibility of call-bridge during
      // the normal lifecycle — the janitor only ensures a row exists.
      const { error: metricErr } = await supabase
        .from("call_metrics")
        .upsert(
          {
            call_id: row.id,
            tenant_id: row.tenant_id,
            call_duration_seconds: ageSeconds,
          },
          { onConflict: "call_id", ignoreDuplicates: true },
        );

      if (metricErr) {
        // Non-fatal — the finalize already happened.
        log.warn(
          { err: metricErr, call_id: row.id },
          "sweepStuckCalls: call_metrics upsert failed",
        );
      }

      log.warn(
        {
          event: "janitor_finalized_call",
          call_id: row.id,
          tenant_id: row.tenant_id,
          age_seconds: ageSeconds,
        },
        "janitor finalized stuck call",
      );
    } catch (err) {
      // Per-row try/catch — one bad row must NOT stop the batch.
      log.error(
        { err, call_id: row?.id },
        "sweepStuckCalls: unexpected per-row error",
      );
    }
  }
}

// ─── Sweep 2: Orphaned audio archives ─────────────────────────────
//
// Calls where the EL webhook landed (webhook_processed_at IS NOT NULL)
// but audio_archive_status is still 'pending' after a 10-minute grace
// window. The original BullMQ job was lost (e.g. worker crash before it
// ran) — re-enqueue it.
//
// We do NOT flip audio_archive_status here; the T7 audio-archive
// processor is the sole writer of 'archived' / 'failed'.

async function sweepOrphanedArchives(supabase, audioArchiveQueue, log) {
  if (!audioArchiveQueue) {
    log.warn("sweepOrphanedArchives: no audioArchiveQueue provided, skipping");
    return;
  }

  const cutoffIso = new Date(
    Date.now() - ORPHAN_ARCHIVE_AGE_MINUTES * 60_000,
  ).toISOString();

  const { data: orphanRows, error: selectErr } = await supabase
    .from("calls")
    .select("id")
    .eq("audio_archive_status", "pending")
    .not("webhook_processed_at", "is", null)
    .lt("webhook_processed_at", cutoffIso)
    .order("webhook_processed_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (selectErr) {
    log.error({ err: selectErr }, "sweepOrphanedArchives: select failed");
    return;
  }
  if (!orphanRows || orphanRows.length === 0) return;

  for (const row of orphanRows) {
    try {
      // BullMQ jobId dedup: if a job with this id already exists in the
      // queue, .add() is a no-op — safe to call repeatedly per sweep.
      //
      // TODO: T7 audio-archive-processor must handle re-enqueued jobs
      // that lack a signedUrl in payload — it should fetch the recording
      // fresh from ElevenLabs via the stored elevenlabs_conversation_id.
      await audioArchiveQueue.add(
        "audio-archive",
        { callId: row.id },
        {
          jobId: `audio:${row.id}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 5000 },
        },
      );

      log.warn(
        { event: "janitor_reenqueued_audio_archive", call_id: row.id },
        "janitor re-enqueued orphaned audio-archive job",
      );
    } catch (err) {
      log.error(
        { err, call_id: row?.id },
        "sweepOrphanedArchives: unexpected per-row error",
      );
    }
  }
}

// ─── Sweep 3: Webhook events cleanup ──────────────────────────────
//
// Delete webhook_events older than 30 days. Forensic window is long
// enough to investigate, short enough to keep the table bounded.

async function sweepOldWebhookEvents(supabase, log) {
  const cutoffIso = new Date(
    Date.now() - WEBHOOK_EVENTS_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("webhook_events")
    .delete()
    .lt("received_at", cutoffIso)
    .select("id");

  if (error) {
    log.error({ err: error }, "sweepOldWebhookEvents: delete failed");
    return;
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    log.info(
      { event: "janitor_deleted_webhook_events", count },
      "janitor cleaned up old webhook_events",
    );
  }
}

// ─── Sweep 4: Call metrics cleanup (deferred) ─────────────────────
//
// TODO: enable once we have >90 days of metrics history.
// const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
// await supabase.from('call_metrics').delete().lt('created_at', ninetyDaysAgo);

// ─── Run loop ─────────────────────────────────────────────────────

/**
 * Start the janitor. Idempotent — calling twice is a no-op.
 * @param {object} args
 * @param {object} args.supabase - Supabase service-role client
 * @param {object} args.audioArchiveQueue - BullMQ Queue for 'audio-archive-jobs'
 * @param {object} args.logger - pino-compatible logger (fastify.log)
 */
export function startJanitor({ supabase, audioArchiveQueue, logger }) {
  if (timerHandle) return; // idempotent

  const log =
    logger && typeof logger.child === "function"
      ? logger.child({ component: "janitor" })
      : logger || console;

  async function runOnce() {
    if (running || stopping) return; // skip if previous run still in flight
    running = true;
    try {
      // Each sweep in its own try/catch — one failing sweep must NOT
      // block the others. The top-level try/catch is belt-and-braces
      // for unforeseen errors (e.g. supabase client exploding).
      try {
        await sweepStuckCalls(supabase, log);
      } catch (err) {
        log.error({ err }, "sweepStuckCalls threw");
      }
      try {
        await sweepOrphanedArchives(supabase, audioArchiveQueue, log);
      } catch (err) {
        log.error({ err }, "sweepOrphanedArchives threw");
      }
      try {
        await sweepOldWebhookEvents(supabase, log);
      } catch (err) {
        log.error({ err }, "sweepOldWebhookEvents threw");
      }
    } catch (err) {
      // Never bubble out — the janitor MUST NEVER crash the host process.
      log.error({ err }, "janitor runOnce: unexpected top-level error");
    } finally {
      running = false;
    }
  }

  // Run once immediately on start, then every 60s.
  // Swallow the promise — runOnce is its own safety net.
  runOnce().catch((err) => {
    try {
      log.error({ err }, "janitor initial run failed");
    } catch {}
  });
  timerHandle = setInterval(() => {
    runOnce().catch((err) => {
      try {
        log.error({ err }, "janitor interval run failed");
      } catch {}
    });
  }, SWEEP_INTERVAL_MS);

  log.info({ intervalMs: SWEEP_INTERVAL_MS }, "janitor started");
}

/**
 * Stop the janitor. Clears the timer, waits for any in-flight sweep to
 * finish, then resolves.
 */
export async function stopJanitor() {
  stopping = true;
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  // Wait for any in-flight run to drain.
  const deadline = Date.now() + 30_000;
  while (running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  stopping = false;
}
