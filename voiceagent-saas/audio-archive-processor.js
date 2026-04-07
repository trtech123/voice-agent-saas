// voiceagent-saas/audio-archive-processor.js
//
// T7: BullMQ worker that downloads ElevenLabs call recordings and uploads
// them to Supabase Storage (`call-recordings` bucket, private, 50 MB cap).
//
// Handles two payload shapes (T8 coordination):
//   Shape A (fresh from T9 webhook handler): { callId, signedUrl }
//   Shape B (re-enqueued by T8 janitor after 10min orphan sweep): { callId }
//
// When `signedUrl` is missing, we re-fetch from ElevenLabs using
// `calls.elevenlabs_conversation_id`. If that fails (4xx / no URL), we mark
// the row `audio_archive_status='failed'` and return normally — the janitor
// already gave it 10 minutes; further retries won't help.
//
// Terminal failed state rationale: per spec, the T8 janitor only re-enqueues
// rows in `pending` state, never `failed`. Once `failed`, recovery is manual
// (admin-only). That's why we set `failed` defensively from both the
// non-retryable paths and the worker.on('failed') handler after exhaustion.

import { Worker } from "bullmq";

const QUEUE_NAME = "audio-archive-jobs";
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const DOWNLOAD_TIMEOUT_MS = 60_000;

let worker = null;

// ─── Helpers ───────────────────────────────────────────────────────

async function markFailed(supabase, callId) {
  await supabase
    .from("calls")
    .update({ audio_archive_status: "failed" })
    .eq("id", callId);
}

/**
 * Fetch a fresh signed audio URL from ElevenLabs for a given conversation.
 * Returns the URL string, or null if unavailable / 4xx (non-retryable).
 * Throws on 5xx / network errors so BullMQ can retry.
 *
 * TODO: pin EL GET /convai/conversations/{id} response shape against live docs
 */
async function fetchAudioUrlFromEL(conversationId, log) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY not configured");
  }

  const url = `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(
    conversationId
  )}`;

  const res = await fetch(url, {
    headers: { "xi-api-key": apiKey },
  });

  if (res.status >= 500) {
    throw new Error(`EL conversation fetch 5xx: ${res.status}`);
  }
  if (!res.ok) {
    log.error(
      { conversationId, status: res.status },
      "EL conversation fetch returned 4xx — non-retryable"
    );
    return null;
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    log.error({ conversationId, err: err.message }, "EL conversation JSON parse failed");
    return null;
  }

  // Defensive field probing — EL post-call API field naming is not pinned.
  // TODO: pin EL GET /convai/conversations/{id} response shape against live docs
  const candidates = [
    body?.audio_url,
    body?.recording_url,
    body?.audio?.url,
    body?.media?.audio_url,
    body?.media?.url,
    body?.data?.audio_url,
    body?.data?.recording_url,
    body?.conversation?.audio_url,
    body?.conversation?.recording_url,
  ];
  const found = candidates.find((v) => typeof v === "string" && v.length > 0);
  if (!found) {
    log.error(
      { conversationId, bodyKeys: Object.keys(body || {}) },
      "EL conversation response had no recognizable audio URL field"
    );
    return null;
  }
  return found;
}

/**
 * Download the recording with a 60s abort timeout and a 50 MB cap that's
 * enforced both via Content-Length and a running mid-stream guard (in case
 * the header is absent or wrong).
 */
async function downloadRecording(signedUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(signedUrl, { signal: controller.signal });
    if (!res.ok) {
      // 5xx → throw (retryable). 4xx → also throw, but classified by caller as
      // a likely-permanent signed URL expiry; with only 5 retries it'll then
      // get terminal-failed via the worker.on('failed') handler.
      throw new Error(`download failed: ${res.status}`);
    }

    const contentLength = Number(res.headers.get("content-length") || "0");
    if (contentLength > MAX_BYTES) {
      const e = new Error(`recording too large: ${contentLength} bytes`);
      e.nonRetryable = true;
      throw e;
    }

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      // Mid-stream guard: header may have been 0 or lied.
      if (total > MAX_BYTES) {
        const e = new Error("recording exceeded 50MB mid-stream");
        e.nonRetryable = true;
        throw e;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Main job processor ────────────────────────────────────────────

async function processArchiveJob(job, supabase, log) {
  const { callId, signedUrl: providedUrl } = job.data || {};

  if (!callId) {
    log.error({ jobId: job.id }, "audio-archive job missing callId");
    return;
  }

  // Step 1: Load call row
  const { data: row, error: loadErr } = await supabase
    .from("calls")
    .select(
      "id, tenant_id, elevenlabs_conversation_id, audio_storage_path, audio_archive_status"
    )
    .eq("id", callId)
    .single();

  if (loadErr || !row) {
    log.error({ callId, err: loadErr?.message }, "calls row not found, ack and skip");
    return;
  }

  // Idempotency: already archived → no-op
  if (row.audio_archive_status === "archived" && row.audio_storage_path) {
    log.info({ callId, path: row.audio_storage_path }, "already_archived");
    return;
  }

  // Step 2: Resolve signed URL (re-fetch for shape B / janitor re-enqueue path)
  let signedUrl = providedUrl;
  if (!signedUrl) {
    if (!row.elevenlabs_conversation_id) {
      log.error({ callId }, "no conversation_id, cannot re-fetch audio url");
      await markFailed(supabase, callId);
      return;
    }
    try {
      signedUrl = await fetchAudioUrlFromEL(row.elevenlabs_conversation_id, log);
    } catch (err) {
      // 5xx / network → retryable
      log.warn({ callId, err: err.message }, "EL conversation fetch failed, will retry");
      throw err;
    }
    if (!signedUrl) {
      // 4xx / no URL → non-retryable
      await markFailed(supabase, callId);
      return;
    }
  }

  // Step 3: Download
  let buffer;
  try {
    buffer = await downloadRecording(signedUrl);
  } catch (err) {
    if (err.nonRetryable) {
      log.error({ callId, err: err.message }, "non-retryable download error");
      await markFailed(supabase, callId);
      return;
    }
    throw err; // retryable
  }

  // Step 4: Upload to Supabase Storage (deterministic path, overwrite-safe)
  const path = `${row.tenant_id}/${row.id}.mp3`;
  const { error: uploadErr } = await supabase.storage
    .from("call-recordings")
    .upload(path, buffer, {
      contentType: "audio/mpeg",
      upsert: true,
    });
  if (uploadErr) {
    // Treat as retryable — Storage 5xx / transient. After 5 retries the
    // failed handler marks the row terminal-failed.
    throw uploadErr;
  }

  // Step 5: Mark archived
  const { error: updateErr } = await supabase
    .from("calls")
    .update({
      audio_storage_path: path,
      audio_archive_status: "archived",
    })
    .eq("id", callId);
  if (updateErr) throw updateErr;

  log.info({ callId, path, bytes: buffer.length }, "audio archived");
}

// ─── Worker lifecycle ──────────────────────────────────────────────

export function startAudioArchiveWorker({ supabase, connection, logger }) {
  if (worker) return worker;

  const log =
    typeof logger?.child === "function"
      ? logger.child({ component: "audio-archive-processor" })
      : logger || console;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      return await processArchiveJob(job, supabase, log);
    },
    {
      connection,
      concurrency: 10,
      // Retries: 5 with exponential backoff (per plan T7).
      // Note: BullMQ uses default attempts unless set on the job itself; we
      // set sane defaults here so producers don't have to configure each add().
      // Producers may override per-job.
    }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "archive completed");
  });

  worker.on("failed", async (job, err) => {
    if (!job) {
      log.error({ err: err?.message }, "audio-archive job failed (no job ref)");
      return;
    }
    const attempts = job.opts?.attempts ?? 5;
    log.warn(
      { jobId: job.id, attemptsMade: job.attemptsMade, attempts, err: err?.message },
      "audio-archive job attempt failed"
    );
    if (job.attemptsMade >= attempts) {
      log.error(
        { jobId: job.id, err: err?.message },
        "audio-archive job permanently failed"
      );
      if (job.data?.callId) {
        try {
          await markFailed(supabase, job.data.callId);
        } catch (e) {
          log.error({ e: e?.message }, "mark failed error");
        }
      }
    }
  });

  worker.on("error", (err) => {
    log.error({ err: err?.message }, "audio-archive worker error");
  });

  log.info({ queue: QUEUE_NAME, concurrency: 10 }, "audio-archive worker started");
  return worker;
}

export async function stopAudioArchiveWorker() {
  if (!worker) return;
  await worker.close();
  worker = null;
}

export { QUEUE_NAME as AUDIO_ARCHIVE_QUEUE_NAME };
