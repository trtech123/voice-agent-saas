// ElevenLabs post-call webhook handler.
// Spec: docs/superpowers/specs/2026-04-07-elevenlabs-runtime-swap-design.md §4.6
// Plan: docs/superpowers/plans/2026-04-07-elevenlabs-runtime-swap-plan.md (T9)
//
// Ground truth from EL support (2026-04-07):
//   Two distinct event types arrive at this endpoint, with NO guarantee of
//   ordering between them:
//     - post_call_transcription  — transcript, analysis, tool calls
//     - post_call_audio          — base64-encoded MP3 of the full call
//
//   Header: `ElevenLabs-Signature: t=<unix_seconds>,v0=<hex_hmac_sha256>`
//   Signed payload: `${t}.${rawBody}` — HMAC-SHA256 keyed by webhook secret.
//   Skew window: 1800 seconds (30 minutes).
//
// Audio handling: synchronous upload to Supabase Storage. No BullMQ queue.
// If the audio webhook arrives BEFORE the transcription webhook, we stage
// the decoded MP3 at `call-recordings/pending/{conversation_id}.mp3`. When
// the transcription handler later runs, it moves the staged file to the
// final path `{tenant_id}/{call_id}.mp3`.
// If the audio webhook is lost entirely, the audio is gone — EL has no
// re-fetch endpoint. This is an accepted terminal failure.

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase-admin";

export const runtime = "nodejs";

// ---- Env ------------------------------------------------------------------
const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET;

// Allow a larger body because post_call_audio carries base64 MP3.
// ~50 MB MP3 → ~67 MB base64 → leave generous headroom.
const MAX_BODY_BYTES = 80 * 1024 * 1024; // 80 MB
const MAX_SKEW_SECONDS = 1800; // 30 minutes — per EL support
const STORAGE_BUCKET = "call-recordings";

// ---- Response helpers ------------------------------------------------------
function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status }
  );
}

function logEvent(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>
) {
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

// ---- Signature verification ------------------------------------------------
// Header format: `t=<unix_seconds>,v0=<hex_hmac_sha256>`
function parseSignatureHeader(
  headerVal: string
): { ts: number; hex: string } | null {
  if (!headerVal) return null;
  const parts = headerVal.split(",").map((p) => p.trim());
  let ts: number | null = null;
  let hex: string | null = null;
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === "t") ts = Number(v);
    else if (k === "v0") hex = v;
  }
  if (ts === null || !Number.isFinite(ts) || !hex) return null;
  return { ts, hex };
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

// ---- Storage helpers -------------------------------------------------------
function pendingPath(conversationId: string): string {
  return `pending/${conversationId}.mp3`;
}
function finalPath(tenantId: string, callId: string): string {
  return `${tenantId}/${callId}.mp3`;
}

async function uploadAudio(
  supabase: ReturnType<typeof createAdminClient>,
  path: string,
  buffer: Buffer
) {
  return await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType: "audio/mpeg",
      upsert: true,
    });
}

// Download, upload to final, then delete pending. If the final upload fails,
// we leave the pending file in place so a later retry can recover it.
// TODO: confirm Supabase Storage has no atomic "move" primitive and this
// download+upload+delete dance is the canonical approach.
async function movePendingToFinal(
  supabase: ReturnType<typeof createAdminClient>,
  conversationId: string,
  tenantId: string,
  callId: string,
  log: (lvl: "info" | "warn" | "error", msg: string, extra?: any) => void
): Promise<string | null> {
  const src = pendingPath(conversationId);
  const dst = finalPath(tenantId, callId);

  const { data: dl, error: dlErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(src);
  if (dlErr || !dl) {
    // Not staged — normal case: audio webhook has not arrived yet.
    return null;
  }
  const arrayBuffer = await dl.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { error: upErr } = await uploadAudio(supabase, dst, buffer);
  if (upErr) {
    log("error", "move pending→final upload failed", { err: upErr.message, dst });
    return null;
  }

  const { error: rmErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .remove([src]);
  if (rmErr) {
    // Non-fatal — the real file is in place. Orphan cleanup left to a
    // future janitor sweep of pending/ > 24h.
    log("warn", "pending cleanup failed (non-fatal)", { err: rmErr.message, src });
  }
  return dst;
}

// ---- Handler ---------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    // ===== Step 0: size + headers =====
    const contentLengthHeader = req.headers.get("content-length");
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
      logEvent("warn", "rejected oversize payload (content-length)", {
        contentLength: contentLengthHeader,
      });
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "payload too large");
    }

    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      logEvent("warn", "rejected oversize payload (post-read)", {
        bytes: Buffer.byteLength(rawBody, "utf8"),
      });
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "payload too large");
    }

    // Next.js normalizes incoming header names to lowercase.
    const signatureHeader = req.headers.get("elevenlabs-signature") ?? "";
    const contentTypeHeader = req.headers.get("content-type") ?? "";

    let parsedBody: any;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      logEvent("warn", "invalid JSON body");
      return errorResponse(400, "INVALID_BODY", "body is not valid JSON");
    }

    const supabase = createAdminClient();

    // ===== Step 1: forensic webhook_events insert (best-effort) =====
    // Note: post_call_audio bodies can be very large (MBs of base64) and the
    // webhook_events.raw_body CHECK constraint caps them at 256 KB. We only
    // persist the raw body when it fits; otherwise we store a metadata stub.
    const bodyBytes = Buffer.byteLength(rawBody, "utf8");
    const weRawBody =
      bodyBytes <= 250_000
        ? parsedBody
        : {
            _truncated: true,
            type: parsedBody?.type ?? null,
            event_timestamp: parsedBody?.event_timestamp ?? null,
            data: {
              conversation_id: parsedBody?.data?.conversation_id ?? null,
            },
            _size: bodyBytes,
          };

    let webhookEventId: string | null = null;
    try {
      const { data: weRow, error: weErr } = await supabase
        .from("webhook_events")
        .insert({
          source: "elevenlabs",
          external_id: null,
          raw_body: weRawBody,
          headers: {
            "elevenlabs-signature": signatureHeader,
            "content-type": contentTypeHeader,
          },
        })
        .select("id")
        .single();
      if (weErr) {
        logEvent("error", "webhook_events insert failed (continuing)", {
          err: weErr.message,
        });
      } else {
        webhookEventId = weRow?.id ?? null;
      }
    } catch (e: any) {
      logEvent("error", "webhook_events insert threw (continuing)", {
        err: e?.message,
      });
    }

    // ===== Step 2: signature + timestamp skew =====
    if (!WEBHOOK_SECRET) {
      logEvent("error", "ELEVENLABS_WEBHOOK_SECRET not configured");
      return errorResponse(
        500,
        "WEBHOOK_SECRET_NOT_CONFIGURED",
        "webhook secret not configured"
      );
    }

    const parsedSig = parseSignatureHeader(signatureHeader);
    if (!parsedSig) {
      if (webhookEventId) {
        await supabase
          .from("webhook_events")
          .update({ processing_error: "invalid_signature_header" })
          .eq("id", webhookEventId);
      }
      logEvent("warn", "missing or malformed ElevenLabs-Signature header");
      return errorResponse(
        400,
        "INVALID_SIGNATURE_HEADER",
        "missing or malformed signature header"
      );
    }

    const nowSeconds = Date.now() / 1000;
    if (Math.abs(nowSeconds - parsedSig.ts) > MAX_SKEW_SECONDS) {
      if (webhookEventId) {
        await supabase
          .from("webhook_events")
          .update({ processing_error: "stale_timestamp" })
          .eq("id", webhookEventId);
      }
      logEvent("warn", "stale webhook timestamp", {
        ts: parsedSig.ts,
        nowSeconds,
      });
      return errorResponse(
        401,
        "STALE_TIMESTAMP",
        "timestamp outside 30-minute skew window"
      );
    }

    const expectedHex = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(`${parsedSig.ts}.${rawBody}`)
      .digest("hex");

    if (!timingSafeEqualHex(expectedHex, parsedSig.hex)) {
      if (webhookEventId) {
        await supabase
          .from("webhook_events")
          .update({ processing_error: "invalid_signature" })
          .eq("id", webhookEventId);
      }
      logEvent("warn", "invalid signature");
      return errorResponse(401, "INVALID_SIGNATURE", "signature verification failed");
    }

    // ===== Step 3: dispatch on event type =====
    const type: string | null = parsedBody?.type ?? null;
    const data = parsedBody?.data ?? {};
    const conversationId: string | null = data?.conversation_id ?? null;

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
      return errorResponse(400, "INVALID_BODY", "missing data.conversation_id");
    }

    if (webhookEventId) {
      await supabase
        .from("webhook_events")
        .update({ external_id: conversationId })
        .eq("id", webhookEventId);
    }

    if (type === "post_call_transcription") {
      return await handleTranscription({
        supabase,
        data,
        conversationId,
        webhookEventId,
      });
    }

    if (type === "post_call_audio") {
      return await handleAudio({
        supabase,
        data,
        conversationId,
        webhookEventId,
      });
    }

    logEvent("warn", "unknown webhook event type", { type });
    if (webhookEventId) {
      await supabase
        .from("webhook_events")
        .update({
          processing_error: `unknown_type:${type ?? "null"}`,
          processed_at: new Date().toISOString(),
        })
        .eq("id", webhookEventId);
    }
    // 200 to prevent retry storms on unknown types.
    return NextResponse.json({ ok: true, ignored: true, type });
  } catch (err: any) {
    // 5xx → EL will retry. That's intended.
    logEvent("error", "unhandled webhook error", {
      err: err?.message,
      stack: err?.stack,
    });
    return errorResponse(500, "INTERNAL", err?.message ?? "internal error");
  }
}

// ---------------------------------------------------------------------------
// post_call_transcription
// ---------------------------------------------------------------------------
async function handleTranscription(args: {
  supabase: ReturnType<typeof createAdminClient>;
  data: any;
  conversationId: string;
  webhookEventId: string | null;
}) {
  const { supabase, data, conversationId, webhookEventId } = args;

  const transcriptFull = data?.transcript ?? null;
  const summary: string | null = data?.analysis?.transcript_summary ?? null;
  const successEvaluation = data?.analysis?.call_successful ?? null;

  // ended_at derivation from conversation timing details.
  // Field shape under data.conversation isn't fully pinned; probe a few.
  let endedAtIso: string | null = null;
  const conv = data?.conversation ?? {};
  const endedAtRaw =
    conv?.ended_at ??
    conv?.end_time ??
    conv?.finished_at ??
    null;
  if (endedAtRaw) {
    const d = new Date(endedAtRaw);
    if (!isNaN(d.getTime())) endedAtIso = d.toISOString();
  } else if (conv?.start_time && typeof conv?.duration_seconds === "number") {
    const startMs = new Date(conv.start_time).getTime();
    if (!isNaN(startMs)) {
      endedAtIso = new Date(startMs + conv.duration_seconds * 1000).toISOString();
    }
  }

  // ===== Lookup call row =====
  const { data: callRow, error: callLookupErr } = await supabase
    .from("calls")
    .select("id, tenant_id, webhook_processed_at, audio_archive_status")
    .eq("elevenlabs_conversation_id", conversationId)
    .maybeSingle();

  if (callLookupErr) {
    logEvent("error", "call lookup failed", { err: callLookupErr.message });
    return errorResponse(500, "INTERNAL", "call lookup failed");
  }

  if (!callRow) {
    // No matching call row. We cannot stage the transcript (tenant_id NOT NULL
    // on calls). Ack idempotently — orchestrator decides how to handle.
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
    return NextResponse.json({
      ok: true,
      call_id: null,
      conversation_id: conversationId,
    });
  }

  const callId: string = callRow.id;
  const tenantId: string = callRow.tenant_id;

  // ===== Atomic idempotent UPDATE on calls =====
  // Gate: `webhook_processed_at IS NULL` — first delivery wins.
  // Note: we do NOT write sentiment — leave NULL as per spec.
  const { data: updatedRows, error: updateErr } = await supabase
    .from("calls")
    .update({
      transcript_full: transcriptFull,
      summary,
      success_evaluation: successEvaluation,
      ended_at: endedAtIso ?? undefined,
      webhook_processed_at: new Date().toISOString(),
    })
    .eq("elevenlabs_conversation_id", conversationId)
    .is("webhook_processed_at", null)
    .select("id");

  if (updateErr) {
    logEvent("error", "calls update failed", {
      err: updateErr.message,
      callId,
    });
    return errorResponse(500, "INTERNAL", "calls update failed");
  }

  if (!updatedRows || updatedRows.length === 0) {
    // Already processed by a previous delivery.
    logEvent("info", "transcription already processed (idempotent replay)", {
      callId,
    });
    if (webhookEventId) {
      await supabase
        .from("webhook_events")
        .update({
          processing_error: "already_processed",
          processed_at: new Date().toISOString(),
        })
        .eq("id", webhookEventId);
    }
    return NextResponse.json({
      ok: true,
      call_id: callId,
      conversation_id: conversationId,
    });
  }

  // ===== Tool call invocations (embedded inside transcript turns) =====
  // TODO: confirm exact tool call shape in transcript items.
  // The EL transcript is an array of turn objects; tool calls appear inline.
  // We probe common field names defensively.
  if (Array.isArray(transcriptFull)) {
    const toolRows: any[] = [];
    for (const turn of transcriptFull) {
      // Possible shapes: turn.tool_calls[], turn.tool_call, turn.tool
      const candidates: any[] = [];
      if (Array.isArray(turn?.tool_calls)) candidates.push(...turn.tool_calls);
      if (turn?.tool_call) candidates.push(turn.tool_call);
      if (turn?.tool && (turn.tool.name || turn.tool.tool_name)) {
        candidates.push(turn.tool);
      }

      for (const tc of candidates) {
        const name = tc?.name ?? tc?.tool_name ?? null;
        const startedAt =
          tc?.started_at ??
          tc?.start_time ??
          tc?.timestamp ??
          turn?.timestamp ??
          turn?.time_in_call_seconds ??
          null;
        if (!name || startedAt == null) continue;

        // startedAt may be a number (seconds since call start) — convert to
        // ISO using ended_at or now() as anchor if we have to. Cleaner once
        // shape is pinned.
        let startedAtIso: string | null = null;
        if (typeof startedAt === "string") {
          const d = new Date(startedAt);
          if (!isNaN(d.getTime())) startedAtIso = d.toISOString();
        } else if (typeof startedAt === "number") {
          // Treat as absolute unix seconds if > 10^9, else skip (we lack a
          // reliable call-start anchor here).
          if (startedAt > 1_000_000_000) {
            startedAtIso = new Date(startedAt * 1000).toISOString();
          }
        }
        if (!startedAtIso) continue;

        toolRows.push({
          call_id: callId,
          tenant_id: tenantId,
          name,
          args: tc?.args ?? tc?.parameters ?? tc?.input ?? null,
          result: tc?.result ?? tc?.output ?? null,
          is_error: !!(tc?.is_error ?? tc?.error),
          started_at: startedAtIso,
          ended_at: tc?.ended_at
            ? new Date(tc.ended_at).toISOString()
            : null,
        });
      }
    }

    if (toolRows.length > 0) {
      const { error: tiErr } = await supabase
        .from("call_tool_invocations")
        .upsert(toolRows, {
          onConflict: "call_id,name,started_at",
          ignoreDuplicates: true,
        });
      if (tiErr) {
        logEvent("error", "call_tool_invocations insert failed (continuing)", {
          err: tiErr.message,
          callId,
          count: toolRows.length,
        });
      }
    }
  }

  // ===== Audio reconciliation: did post_call_audio arrive first? =====
  // If yes, the file lives at pending/{conversation_id}.mp3 — move it into
  // place under {tenant_id}/{call_id}.mp3 and mark archived. Otherwise set
  // pending and wait for the audio webhook.
  const dst = await movePendingToFinal(
    supabase,
    conversationId,
    tenantId,
    callId,
    (lvl, msg, extra) => logEvent(lvl, msg, extra)
  );

  if (dst) {
    await supabase
      .from("calls")
      .update({
        audio_storage_path: dst,
        audio_archive_status: "archived",
      })
      .eq("id", callId);
  } else {
    // No staged audio — normal case, set pending.
    await supabase
      .from("calls")
      .update({ audio_archive_status: "pending" })
      .eq("id", callId)
      .is("audio_storage_path", null);
  }

  if (webhookEventId) {
    await supabase
      .from("webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        processing_error: null,
      })
      .eq("id", webhookEventId);
  }

  return NextResponse.json({
    ok: true,
    call_id: callId,
    conversation_id: conversationId,
  });
}

// ---------------------------------------------------------------------------
// post_call_audio
// ---------------------------------------------------------------------------
async function handleAudio(args: {
  supabase: ReturnType<typeof createAdminClient>;
  data: any;
  conversationId: string;
  webhookEventId: string | null;
}) {
  const { supabase, data, conversationId, webhookEventId } = args;

  const fullAudioBase64: string | null = data?.full_audio ?? null;
  if (!fullAudioBase64 || typeof fullAudioBase64 !== "string") {
    logEvent("warn", "post_call_audio missing full_audio", { conversationId });
    if (webhookEventId) {
      await supabase
        .from("webhook_events")
        .update({
          processing_error: "missing_full_audio",
          processed_at: new Date().toISOString(),
        })
        .eq("id", webhookEventId);
    }
    return errorResponse(400, "INVALID_BODY", "missing data.full_audio");
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(fullAudioBase64, "base64");
  } catch (e: any) {
    logEvent("error", "base64 decode failed", { err: e?.message });
    return errorResponse(400, "INVALID_BODY", "invalid base64 audio");
  }

  // Try to find the call row. If it exists → upload to final path. If not →
  // stage at pending/{conversation_id}.mp3 for the transcription handler to
  // move later.
  const { data: callRow, error: lookupErr } = await supabase
    .from("calls")
    .select("id, tenant_id, audio_archive_status")
    .eq("elevenlabs_conversation_id", conversationId)
    .maybeSingle();

  if (lookupErr) {
    logEvent("error", "audio: call lookup failed", { err: lookupErr.message });
    return errorResponse(500, "INTERNAL", "call lookup failed");
  }

  if (!callRow) {
    // No call row yet — stage at pending/.
    const src = pendingPath(conversationId);
    const { error: upErr } = await uploadAudio(supabase, src, buffer);
    if (upErr) {
      logEvent("error", "pending audio upload failed", {
        err: upErr.message,
        src,
      });
      return errorResponse(500, "INTERNAL", "pending audio upload failed");
    }
    logEvent("info", "audio staged to pending/", {
      conversationId,
      bytes: buffer.length,
    });
    if (webhookEventId) {
      await supabase
        .from("webhook_events")
        .update({
          processed_at: new Date().toISOString(),
          processing_error: null,
        })
        .eq("id", webhookEventId);
    }
    return NextResponse.json({
      ok: true,
      staged: true,
      conversation_id: conversationId,
    });
  }

  // Idempotency guard on the audio path: if already archived, no-op.
  if (callRow.audio_archive_status === "archived") {
    logEvent("info", "audio already archived (idempotent replay)", {
      callId: callRow.id,
    });
    if (webhookEventId) {
      await supabase
        .from("webhook_events")
        .update({
          processed_at: new Date().toISOString(),
          processing_error: "already_archived",
        })
        .eq("id", webhookEventId);
    }
    return NextResponse.json({
      ok: true,
      call_id: callRow.id,
      conversation_id: conversationId,
    });
  }

  const dst = finalPath(callRow.tenant_id, callRow.id);
  const { error: upErr } = await uploadAudio(supabase, dst, buffer);
  if (upErr) {
    logEvent("error", "final audio upload failed", {
      err: upErr.message,
      dst,
    });
    return errorResponse(500, "INTERNAL", "audio upload failed");
  }

  const { error: updateErr } = await supabase
    .from("calls")
    .update({
      audio_storage_path: dst,
      audio_archive_status: "archived",
    })
    .eq("id", callRow.id)
    .neq("audio_archive_status", "archived");
  if (updateErr) {
    logEvent("error", "calls audio status update failed", {
      err: updateErr.message,
      callId: callRow.id,
    });
    // Upload succeeded — don't fail the webhook; return 200.
  }

  if (webhookEventId) {
    await supabase
      .from("webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        processing_error: null,
      })
      .eq("id", webhookEventId);
  }

  return NextResponse.json({
    ok: true,
    call_id: callRow.id,
    conversation_id: conversationId,
  });
}
