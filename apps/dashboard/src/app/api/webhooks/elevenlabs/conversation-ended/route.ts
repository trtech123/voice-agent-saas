// ElevenLabs conversation-ended webhook handler.
// Spec: docs/superpowers/specs/2026-04-07-elevenlabs-runtime-swap-design.md §4.6
// Plan: docs/superpowers/plans/2026-04-07-elevenlabs-runtime-swap-plan.md (T9)
//
// Step ordering is LOAD-BEARING. Do not reorder without re-reading T9 acceptance criteria.

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { Queue } from "bullmq";
import { createAdminClient } from "@/lib/supabase-admin";

export const runtime = "nodejs";

// ---- Env (read at module top) ---------------------------------------------
const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET;
const REDIS_URL = process.env.REDIS_URL;

const MAX_BODY_BYTES = 262144; // 256 KB — also enforced by webhook_events CHECK constraint
const MAX_SKEW_SECONDS = 300; // 5 minutes

// ---- Module-level BullMQ producer for audio-archive jobs ------------------
// Singleton — never re-instantiate per request.
let audioArchiveQueue: Queue | null = null;
function getAudioArchiveQueue(): Queue | null {
  if (!REDIS_URL) return null;
  if (!audioArchiveQueue) {
    audioArchiveQueue = new Queue("audio-archive-jobs", {
      connection: { url: REDIS_URL },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return audioArchiveQueue;
}

// ---- Response helpers ------------------------------------------------------
function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status }
  );
}

function logEvent(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({
    level,
    msg,
    component: "webhook.elevenlabs.conversation-ended",
    ts: new Date().toISOString(),
    ...extra,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---- Signature parsing/verification ---------------------------------------
// EL signing follows the Stripe-style convention: sign `${timestamp}.${rawBody}`
// with HMAC-SHA256 keyed by the webhook secret. The `elevenlabs-signature`
// header may arrive as either:
//   - raw hex digest, OR
//   - `t=<unix>,v0=<hex>` comma-separated key=value pairs.
// We accept both shapes.
function extractSignatureHex(headerVal: string): string | null {
  if (!headerVal) return null;
  if (headerVal.includes("=")) {
    const parts = headerVal.split(",").map((p) => p.trim());
    for (const p of parts) {
      const [k, v] = p.split("=");
      if (k === "v0" && v) return v;
    }
    return null;
  }
  return headerVal.trim();
}

function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  if (!aHex || !bHex) return false;
  if (aHex.length !== bHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(aHex, "hex"), Buffer.from(bHex, "hex"));
  } catch {
    return false;
  }
}

// ---- Field extraction (defensive — EL post-call payload schema is not
// pinned in Appendix A; Appendix A only covers the live WS protocol).
// TODO: pin against EL post-call webhook docs once available.
function pick<T = unknown>(obj: any, paths: string[]): T | undefined {
  for (const path of paths) {
    const parts = path.split(".");
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in cur) cur = cur[p];
      else {
        ok = false;
        break;
      }
    }
    if (ok && cur !== undefined && cur !== null) return cur as T;
  }
  return undefined;
}

// ---- Handler --------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    // ===== Step 0: pre-checks (NO DB writes yet) =====
    const contentLengthHeader = req.headers.get("content-length");
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
      logEvent("warn", "rejected oversize payload (content-length)", {
        contentLength: contentLengthHeader,
      });
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "payload exceeds 256 KB");
    }

    // Canonical timestamp header is `elevenlabs-signature-timestamp`; fall back to `x-elevenlabs-timestamp`.
    const timestampHeader =
      req.headers.get("elevenlabs-signature-timestamp") ??
      req.headers.get("x-elevenlabs-timestamp");
    if (!timestampHeader) {
      logEvent("warn", "missing timestamp header");
      return errorResponse(400, "MISSING_TIMESTAMP", "missing timestamp header");
    }

    // Read raw body as text (needed for HMAC + JSON.parse).
    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      logEvent("warn", "rejected oversize payload (post-read)", {
        bytes: Buffer.byteLength(rawBody, "utf8"),
      });
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "payload exceeds 256 KB");
    }

    const signatureHeader = req.headers.get("elevenlabs-signature") ?? "";
    const contentTypeHeader = req.headers.get("content-type") ?? "";

    // ===== Step 1: forensic insert into webhook_events BEFORE verification =====
    // If the body isn't valid JSON, return 400 (raw_body column is jsonb).
    let parsedBody: any;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      logEvent("warn", "invalid JSON body");
      return errorResponse(400, "INVALID_BODY", "body is not valid JSON");
    }

    const supabase = createAdminClient();

    let webhookEventId: string | null = null;
    try {
      const { data: weRow, error: weErr } = await supabase
        .from("webhook_events")
        .insert({
          source: "elevenlabs",
          external_id: null,
          raw_body: parsedBody,
          headers: {
            "elevenlabs-signature": signatureHeader,
            "elevenlabs-signature-timestamp": timestampHeader,
            "content-type": contentTypeHeader,
          },
        })
        .select("id")
        .single();
      if (weErr) {
        // Forensic insert is best-effort — never blocks the webhook.
        logEvent("error", "webhook_events insert failed (continuing)", { err: weErr.message });
      } else {
        webhookEventId = weRow?.id ?? null;
      }
    } catch (e: any) {
      logEvent("error", "webhook_events insert threw (continuing)", { err: e?.message });
    }

    // ===== Step 2: HMAC + timestamp skew verification =====
    if (!WEBHOOK_SECRET) {
      logEvent("error", "ELEVENLABS_WEBHOOK_SECRET not configured");
      return errorResponse(
        500,
        "WEBHOOK_SECRET_NOT_CONFIGURED",
        "webhook secret not configured"
      );
    }

    const timestampSeconds = Number(timestampHeader);
    if (!Number.isFinite(timestampSeconds)) {
      if (webhookEventId) {
        await supabase
          .from("webhook_events")
          .update({ processing_error: "invalid_signature" })
          .eq("id", webhookEventId);
      }
      logEvent("warn", "timestamp header not numeric");
      return errorResponse(400, "MISSING_TIMESTAMP", "timestamp header malformed");
    }

    const nowSeconds = Date.now() / 1000;
    if (Math.abs(nowSeconds - timestampSeconds) > MAX_SKEW_SECONDS) {
      if (webhookEventId) {
        await supabase
          .from("webhook_events")
          .update({ processing_error: "stale_timestamp" })
          .eq("id", webhookEventId);
      }
      logEvent("warn", "stale webhook timestamp", { timestampSeconds, nowSeconds });
      return errorResponse(401, "STALE_TIMESTAMP", "timestamp outside 5-minute skew window");
    }

    const expectedHex = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(`${timestampHeader}.${rawBody}`)
      .digest("hex");

    const providedHex = extractSignatureHex(signatureHeader);

    if (!providedHex || !timingSafeEqualHex(expectedHex, providedHex)) {
      if (webhookEventId) {
        await supabase
          .from("webhook_events")
          .update({ processing_error: "invalid_signature" })
          .eq("id", webhookEventId);
      }
      logEvent("warn", "invalid signature", { hasHeader: !!signatureHeader });
      return errorResponse(401, "INVALID_SIGNATURE", "signature verification failed");
    }

    // ===== Step 3: extract fields (defensive) =====
    const conversationId =
      pick<string>(parsedBody, ["conversation_id", "data.conversation_id"]) ?? null;

    if (!conversationId) {
      if (webhookEventId) {
        await supabase
          .from("webhook_events")
          .update({
            processing_error: "missing_conversation_id",
            processed_at: new Date().toISOString(),
          })
          .eq("id", webhookEventId);
      }
      logEvent("warn", "payload missing conversation_id");
      return errorResponse(400, "INVALID_BODY", "missing conversation_id");
    }

    const transcriptFull =
      pick<unknown>(parsedBody, ["transcript", "data.transcript"]) ?? null;
    const summary =
      pick<string>(parsedBody, [
        "analysis.summary",
        "data.analysis.summary",
        "summary",
      ]) ?? null;
    const sentiment =
      pick<string>(parsedBody, [
        "analysis.sentiment",
        "data.analysis.sentiment",
        "sentiment",
      ]) ?? null;
    const successEvaluation =
      pick<unknown>(parsedBody, [
        "analysis.success_evaluation",
        "data.analysis.success_evaluation",
        "success_evaluation",
      ]) ?? null;
    const audioUrl =
      pick<string>(parsedBody, ["audio_url", "data.audio_url"]) ?? null;
    const durationSeconds =
      pick<number>(parsedBody, ["duration_seconds", "data.duration_seconds"]) ?? null;
    const endedAtRaw = pick<string | number>(parsedBody, ["ended_at", "data.ended_at"]);
    const startedAtRaw = pick<string | number>(parsedBody, [
      "started_at",
      "data.started_at",
    ]);
    let endedAtIso: string | null = null;
    if (endedAtRaw) {
      const d = new Date(endedAtRaw as any);
      if (!isNaN(d.getTime())) endedAtIso = d.toISOString();
    } else if (startedAtRaw && typeof durationSeconds === "number") {
      const startMs = new Date(startedAtRaw as any).getTime();
      if (!isNaN(startMs)) endedAtIso = new Date(startMs + durationSeconds * 1000).toISOString();
    }

    const toolCalls =
      pick<any[]>(parsedBody, ["tool_calls", "data.tool_calls", "analysis.tool_calls"]) ??
      [];

    // Backfill webhook_events.external_id for traceability.
    if (webhookEventId) {
      await supabase
        .from("webhook_events")
        .update({ external_id: conversationId })
        .eq("id", webhookEventId);
    }

    // ===== Step 4: lookup call by elevenlabs_conversation_id =====
    const { data: callRow, error: callLookupErr } = await supabase
      .from("calls")
      .select("id, tenant_id, webhook_processed_at")
      .eq("elevenlabs_conversation_id", conversationId)
      .maybeSingle();

    if (callLookupErr) {
      logEvent("error", "call lookup failed", { err: callLookupErr.message });
      // Treat as transient — let EL retry.
      return errorResponse(500, "INTERNAL", "call lookup failed");
    }

    if (!callRow) {
      logEvent("warn", "no matching call for conversation_id", { conversationId });
      if (webhookEventId) {
        await supabase
          .from("webhook_events")
          .update({
            processing_error: "no_matching_call",
            processed_at: new Date().toISOString(),
          })
          .eq("id", webhookEventId);
      }
      // 200 — idempotent no-op, prevent EL retry storms.
      return NextResponse.json({ ok: true, call_id: null, conversation_id: conversationId });
    }

    const callId: string = callRow.id;
    const tenantId: string = callRow.tenant_id;

    // ===== Step 5: atomic idempotent UPDATE on calls =====
    // PostgREST emulates the `WHERE webhook_processed_at IS NULL` gate via .is(...).
    // The combination of the eq filter on conversation_id + is null on
    // webhook_processed_at is the canonical idempotency gate.
    const { data: updatedRows, error: updateErr } = await supabase
      .from("calls")
      .update({
        transcript_full: transcriptFull,
        summary,
        sentiment,
        success_evaluation: successEvaluation,
        ended_at: endedAtIso ?? undefined, // skip if null so we don't clobber an existing value
        webhook_processed_at: new Date().toISOString(),
        audio_archive_status: "pending",
      })
      .eq("elevenlabs_conversation_id", conversationId)
      .is("webhook_processed_at", null)
      .select("id");

    if (updateErr) {
      logEvent("error", "calls update failed", { err: updateErr.message, callId });
      return errorResponse(500, "INTERNAL", "calls update failed");
    }

    if (!updatedRows || updatedRows.length === 0) {
      // Already processed by a previous delivery — idempotent no-op.
      logEvent("info", "webhook already processed (idempotent replay)", { callId });
      if (webhookEventId) {
        await supabase
          .from("webhook_events")
          .update({
            processing_error: "already_processed",
            processed_at: new Date().toISOString(),
          })
          .eq("id", webhookEventId);
      }
      return NextResponse.json({ ok: true, call_id: callId, conversation_id: conversationId });
    }

    // ===== Step 6: insert call_tool_invocations rows (sole writer) =====
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const rows = toolCalls
        .map((tc: any) => {
          const name = tc?.name ?? tc?.tool_name ?? null;
          const startedAt =
            tc?.started_at ?? tc?.start_time ?? tc?.created_at ?? null;
          const endedAt = tc?.ended_at ?? tc?.end_time ?? tc?.completed_at ?? null;
          if (!name || !startedAt) return null;
          return {
            call_id: callId,
            tenant_id: tenantId,
            name,
            args: tc?.args ?? tc?.parameters ?? tc?.input ?? null,
            result: tc?.result ?? tc?.output ?? null,
            is_error: !!(tc?.is_error ?? tc?.error),
            started_at: new Date(startedAt).toISOString(),
            ended_at: endedAt ? new Date(endedAt).toISOString() : null,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (rows.length > 0) {
        // ON CONFLICT (call_id, name, started_at) DO NOTHING via PostgREST upsert
        // with ignoreDuplicates: true. The unique constraint is defined in the
        // 2026-04-07 elevenlabs runtime swap migration.
        const { error: tiErr } = await supabase
          .from("call_tool_invocations")
          .upsert(rows, {
            onConflict: "call_id,name,started_at",
            ignoreDuplicates: true,
          });
        if (tiErr) {
          // Non-fatal: log and continue. Transcript already saved.
          logEvent("error", "call_tool_invocations insert failed (continuing)", {
            err: tiErr.message,
            callId,
            count: rows.length,
          });
        }
      }
    }

    // ===== Step 7: enqueue audio-archive job (async) =====
    if (audioUrl) {
      const queue = getAudioArchiveQueue();
      if (!queue) {
        logEvent("warn", "REDIS_URL not set; skipping audio-archive enqueue (janitor will sweep)", {
          callId,
        });
      } else {
        try {
          await queue.add(
            "archive",
            { callId, signedUrl: audioUrl },
            {
              jobId: `audio:${callId}`,
              attempts: 5,
              backoff: { type: "exponential", delay: 5000 },
            }
          );
        } catch (e: any) {
          logEvent("error", "audio-archive enqueue failed", { err: e?.message, callId });
          // Mark as failed; janitor orphan-sweep will pick it up later.
          await supabase
            .from("calls")
            .update({ audio_archive_status: "failed" })
            .eq("id", callId);
          // Still return 200 — transcript is saved.
        }
      }
    } else {
      logEvent("warn", "no audio_url in payload; janitor will sweep", { callId });
    }

    // ===== Step 8: mark webhook_event processed =====
    if (webhookEventId) {
      await supabase
        .from("webhook_events")
        .update({
          processed_at: new Date().toISOString(),
          processing_error: null,
        })
        .eq("id", webhookEventId);
    }

    // ===== Step 9: 200 OK =====
    return NextResponse.json({
      ok: true,
      call_id: callId,
      conversation_id: conversationId,
    });
  } catch (err: any) {
    // EL will retry on 5xx — that's intended.
    logEvent("error", "unhandled webhook error", { err: err?.message, stack: err?.stack });
    return errorResponse(500, "INTERNAL", err?.message ?? "internal error");
  }
}
