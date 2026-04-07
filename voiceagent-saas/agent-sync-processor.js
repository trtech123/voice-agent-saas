// voiceagent-saas/agent-sync-processor.js

/**
 * Agent Sync Processor — BullMQ worker that reconciles `campaigns` rows to
 * ElevenLabs Conversational AI agents via REST.
 *
 * Implements task T6 of the 2026-04-07 ElevenLabs runtime swap plan.
 * Design reference: docs/superpowers/specs/2026-04-07-elevenlabs-runtime-swap-design.md §4.2
 *
 * Race-safety strategy (CAS via campaigns.sync_version):
 *   1. Snapshot row + sync_version.
 *   2. CAS-mark agent_status='provisioning'. If 0 rows → another job is ahead, exit clean.
 *   3. Build payload, call EL REST.
 *   4. CAS-write the result (agent_id, etag, status). If 0 rows → newer job will reconcile.
 *
 * Producer contract (NOT enforced here):
 *   The enqueueing side (dashboard server actions) MUST set
 *     jobId: `agent-sync:${campaignId}`
 *     delay: 2000
 *   so BullMQ collapses bursts of edits into a single trailing job.
 */

import { Worker } from "bullmq";
import { buildElevenLabsClientTools } from "./elevenlabs-tools-adapter.js";

const QUEUE_NAME = "agent-sync-jobs";
const EL_BASE = "https://api.elevenlabs.io";
const HTTP_TIMEOUT_MS = 15_000;

let worker = null;

// ─── Worker lifecycle ──────────────────────────────────────────────

export function startAgentSyncWorker({ supabase, connection, logger }) {
  if (worker) return worker;
  const log = logger?.child?.({ component: "agent-sync-processor" }) ?? logger ?? console;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => processAgentSyncJob(job, supabase, log),
    {
      connection,
      concurrency: 5,
      // Retries 3 with exponential backoff. Only retryable errors throw;
      // 4xx outcomes are persisted as agent_status='failed' and the job
      // returns normally so BullMQ marks it complete.
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      },
    }
  );

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err?.message }, "agent-sync job failed");
  });
  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "agent-sync job completed");
  });
  worker.on("error", (err) => {
    log.error({ err: err?.message }, "agent-sync worker error");
  });

  log.info({ queue: QUEUE_NAME, concurrency: 5 }, "agent-sync worker started");
  return worker;
}

export async function stopAgentSyncWorker() {
  if (!worker) return;
  await worker.close();
  worker = null;
}

// ─── Job handler ───────────────────────────────────────────────────

async function processAgentSyncJob(job, supabase, parentLog) {
  const { campaignId, action } = job.data || {};
  const log = parentLog.child?.({ jobId: job.id, campaignId, action }) ?? parentLog;

  if (!campaignId || !action) {
    log.error("invalid job payload — missing campaignId or action");
    return;
  }
  if (!["create", "update", "delete"].includes(action)) {
    log.error({ action }, "invalid action");
    return;
  }

  // -- Step 2: snapshot campaign row --
  const { data: row, error: readErr } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();

  if (readErr || !row) {
    log.error({ err: readErr?.message }, "campaign row not found — acknowledging job");
    return;
  }

  const snapshotSyncVersion = row.sync_version;

  // -- Step 3: CAS transition to provisioning --
  // Don't stomp a newer edit; if 0 rows update, the newer job is already queued.
  const { data: provRows, error: provErr } = await supabase
    .from("campaigns")
    .update({ agent_status: "provisioning" })
    .eq("id", campaignId)
    .eq("sync_version", snapshotSyncVersion)
    .select("id");

  if (provErr) {
    // Treat DB error as retryable
    log.error({ err: provErr.message }, "failed to mark provisioning");
    throw new Error(`provisioning CAS failed: ${provErr.message}`);
  }
  if (!provRows || provRows.length === 0) {
    log.info("CAS lost on provisioning — newer job queued, exiting");
    return;
  }

  // -- Step 4: voice_id guard for create/update --
  if ((action === "create" || action === "update") && !row.voice_id) {
    log.warn("voice_id missing — marking failed without calling EL");
    await casMarkFailed(
      supabase,
      campaignId,
      snapshotSyncVersion,
      "voice_id is required; user must pick via voice picker",
      log
    );
    return;
  }

  // -- Step 5: dispatch action --
  try {
    if (action === "delete") {
      await handleDelete(supabase, row, snapshotSyncVersion, log);
      return;
    }

    // create / update
    const payload = buildAgentPayload(row);

    // If update but no agent_id, fall through to create
    let effectiveAction = action;
    if (action === "update" && !row.elevenlabs_agent_id) {
      log.info("update on never-synced campaign — falling through to create");
      effectiveAction = "create";
    }

    if (effectiveAction === "create") {
      await handleCreate(supabase, row, payload, snapshotSyncVersion, log);
    } else {
      await handleUpdate(supabase, row, payload, snapshotSyncVersion, log);
    }
  } catch (err) {
    if (isRetryable(err)) {
      log.warn({ err: err.message }, "retryable error — throwing for BullMQ retry");
      throw err;
    }
    // Non-retryable: persist failure and ack
    log.error({ err: err.message }, "non-retryable error — marking failed");
    await casMarkFailed(supabase, campaignId, snapshotSyncVersion, err.message, log);
  }
}

// ─── Action handlers ───────────────────────────────────────────────

async function handleCreate(supabase, row, payload, snapshotSyncVersion, log) {
  const res = await elFetch("POST", `${EL_BASE}/v1/convai/agents/create`, {
    body: payload,
    // Idempotency-Key: opportunistic; EL may ignore it today, but it future-proofs
    // against duplicate creates if the producer ever loses the dedup jobId.
    headers: { "X-ElevenLabs-Idempotency-Key": row.external_ref || row.id },
  });

  if (!res.ok) {
    await handleNon2xx(res, supabase, row.id, snapshotSyncVersion, log, "create");
    return;
  }

  const json = await res.json();
  const agentId = json?.agent_id || json?.id || json?.agent?.agent_id;
  if (!agentId) {
    throw new Error("EL create returned no agent_id");
  }
  const etag = res.headers.get("etag");

  await casWriteSuccess(supabase, row.id, snapshotSyncVersion, {
    elevenlabs_agent_id: agentId,
    el_etag: etag,
    log,
  });
}

async function handleUpdate(supabase, row, payload, snapshotSyncVersion, log) {
  const url = `${EL_BASE}/v1/convai/agents/${row.elevenlabs_agent_id}`;
  const headers = {};
  if (row.el_etag) headers["If-Match"] = row.el_etag;

  let res = await elFetch("PATCH", url, { body: payload, headers });

  // 412 → fetch fresh etag, retry once
  if (res.status === 412) {
    log.warn("etag precondition failed — fetching fresh etag and retrying once");
    const getRes = await elFetch("GET", url);
    if (!getRes.ok) {
      await handleNon2xx(getRes, supabase, row.id, snapshotSyncVersion, log, "update-get");
      return;
    }
    const freshEtag = getRes.headers.get("etag");
    res = await elFetch("PATCH", url, {
      body: payload,
      headers: freshEtag ? { "If-Match": freshEtag } : {},
    });
    if (res.status === 412) {
      log.error("persistent etag conflict after refresh");
      await casMarkFailed(
        supabase,
        row.id,
        snapshotSyncVersion,
        "persistent etag conflict",
        log
      );
      return;
    }
  }

  // 404 → agent deleted externally, fall through to create
  if (res.status === 404) {
    log.warn("agent missing on EL side — clearing local id and recreating");
    await supabase
      .from("campaigns")
      .update({ elevenlabs_agent_id: null, el_etag: null })
      .eq("id", row.id)
      .eq("sync_version", snapshotSyncVersion);
    await handleCreate(
      supabase,
      { ...row, elevenlabs_agent_id: null, el_etag: null },
      payload,
      snapshotSyncVersion,
      log
    );
    return;
  }

  if (!res.ok) {
    await handleNon2xx(res, supabase, row.id, snapshotSyncVersion, log, "update");
    return;
  }

  const newEtag = res.headers.get("etag");
  await casWriteSuccess(supabase, row.id, snapshotSyncVersion, {
    elevenlabs_agent_id: row.elevenlabs_agent_id,
    el_etag: newEtag,
    log,
  });
}

async function handleDelete(supabase, row, snapshotSyncVersion, log) {
  if (!row.elevenlabs_agent_id) {
    log.info("nothing to delete — clearing local state");
    await supabase
      .from("campaigns")
      .update({
        agent_status: null,
        elevenlabs_agent_id: null,
        el_etag: null,
        agent_sync_error: null,
        agent_synced_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("sync_version", snapshotSyncVersion);
    return;
  }

  const res = await elFetch(
    "DELETE",
    `${EL_BASE}/v1/convai/agents/${row.elevenlabs_agent_id}`
  );

  if (res.status === 404 || res.ok) {
    await supabase
      .from("campaigns")
      .update({
        agent_status: null,
        elevenlabs_agent_id: null,
        el_etag: null,
        agent_sync_error: null,
        agent_synced_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("sync_version", snapshotSyncVersion);
    return;
  }

  await handleNon2xx(res, supabase, row.id, snapshotSyncVersion, log, "delete");
}

// ─── EL payload builder ────────────────────────────────────────────

function buildAgentPayload(row) {
  return {
    name: row.name || `campaign-${row.id}`,
    conversation_config: {
      agent: {
        prompt: { prompt: row.prompt || row.script || "" },
        first_message: row.first_message || "",
        language: "he",
      },
      tts: {
        voice_id: row.voice_id,
        ...(row.tts_model ? { model_id: row.tts_model } : {}),
      },
    },
    // client_tools: vendor-translated from tools.js via the EL adapter.
    // All Spec A tools have side effects → caller marks them blocking elsewhere
    // (or via platform_settings) once EL doc shape is finalized.
    client_tools: buildElevenLabsClientTools(),
    platform_settings: {},
  };
}

// ─── HTTP + error helpers ──────────────────────────────────────────

async function elFetch(method, url, { body, headers = {} } = {}) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    const e = new Error("ELEVENLABS_API_KEY not set");
    e.nonRetryable = true;
    throw e;
  }
  const init = {
    method,
    headers: {
      "xi-api-key": apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  };
  if (body) init.body = JSON.stringify(body);
  return await fetch(url, init);
}

async function handleNon2xx(res, supabase, campaignId, snapshotSyncVersion, log, op) {
  if (res.status >= 500) {
    const text = await safeText(res);
    const err = new Error(`EL ${op} ${res.status}: ${text}`);
    throw err; // retryable
  }
  // 4xx — non-retryable
  const text = await safeText(res);
  log.error({ status: res.status, body: text }, `EL ${op} 4xx`);
  await casMarkFailed(
    supabase,
    campaignId,
    snapshotSyncVersion,
    `EL ${op} ${res.status}: ${text}`.slice(0, 1000),
    log
  );
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

function isRetryable(err) {
  if (err?.nonRetryable) return false;
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return true;
  if (err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT" || err?.code === "ENOTFOUND") {
    return true;
  }
  // Errors thrown above for >=500 carry status text in message; default-throw is retryable
  // unless explicitly marked otherwise.
  return true;
}

// ─── CAS write helpers ─────────────────────────────────────────────

async function casWriteSuccess(supabase, campaignId, snapshotSyncVersion, fields) {
  const log = fields.log;
  const update = {
    elevenlabs_agent_id: fields.elevenlabs_agent_id,
    agent_status: "ready",
    el_etag: fields.el_etag ?? null,
    agent_synced_at: new Date().toISOString(),
    agent_sync_error: null,
  };
  const { data, error } = await supabase
    .from("campaigns")
    .update(update)
    .eq("id", campaignId)
    .eq("sync_version", snapshotSyncVersion)
    .select("id");

  if (error) {
    log.error({ err: error.message }, "CAS write-back error");
    throw new Error(`CAS write-back failed: ${error.message}`);
  }
  if (!data || data.length === 0) {
    log.info("CAS lost on write-back — newer job will reconcile");
    return;
  }
  log.info({ agentId: fields.elevenlabs_agent_id }, "agent sync success");
}

async function casMarkFailed(supabase, campaignId, snapshotSyncVersion, errorMessage, log) {
  const { data, error } = await supabase
    .from("campaigns")
    .update({
      agent_status: "failed",
      agent_sync_error: errorMessage,
      agent_synced_at: new Date().toISOString(),
    })
    .eq("id", campaignId)
    .eq("sync_version", snapshotSyncVersion)
    .select("id");

  if (error) {
    log.error({ err: error.message }, "failed to write failure state");
    return;
  }
  if (!data || data.length === 0) {
    log.info("CAS lost when marking failed — newer job will reconcile");
  }
}
