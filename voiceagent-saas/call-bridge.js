// voiceagent-saas/call-bridge.js

/**
 * Call Bridge — Audio bridge between Asterisk (slin16) and ElevenLabs
 * Conversational AI.
 *
 * Spec: docs/superpowers/specs/2026-04-07-elevenlabs-runtime-swap-design.md §4.4
 * Plan: docs/superpowers/plans/2026-04-07-elevenlabs-runtime-swap-plan.md (T12)
 *
 * Lifecycle per call (§4.4):
 *  1. Read agent_id_used / sync_version_used from job payload (snapshotted by
 *     call-processor at dequeue per T11).
 *  2. CAS assertion against current campaigns row — if drifted, hang up with
 *     failure_reason='agent_version_mismatch' (no retry bump).
 *  3. Open ExternalMedia (already wired by media-bridge), construct
 *     ElevenLabsSession, pipe audio in/out, route transcripts to
 *     live-turn-writer, dispatch tool_call events through tools.executeToolCall.
 *  4. StasisEnd / cleanup ALWAYS finalizes — invariant from §4.4 / §4.8 janitor.
 *
 * Read-only on campaign_contacts.daily_retry_count — call-processor is the sole
 * writer per T11.
 */

import { ElevenLabsSession } from "./elevenlabs-session.js";
import { enqueueTurn, flushAndClose } from "./live-turn-writer.js";
import { executeToolCall } from "./tools.js";

// ─── Active Bridge Tracking ─────────────────────────────────────────

const activeBridges = new Map();

export function getActiveBridgeCount() {
  return activeBridges.size;
}

export function getActiveBridge(callId) {
  return activeBridges.get(callId);
}

/**
 * Pre-register a CallBridge instance BEFORE initiating the Asterisk call.
 * This ensures media-bridge can find the bridge when ExternalMedia connects.
 */
export function preRegisterBridge(callId, bridge) {
  activeBridges.set(callId, bridge);
}

export function cleanupAllBridges() {
  for (const [, bridge] of activeBridges) {
    bridge.endBridge("server_shutdown");
  }
}

// ─── Failure Reason Mapping (spec §5.1) ─────────────────────────────

/**
 * Map ElevenLabsSession error codes to call_failure_reason_t enum values.
 * Conservative fallback is el_ws_dropped (no dedicated enum value for
 * protocol_error / audio_format_mismatch).
 */
function mapErrorCodeToFailureReason(code) {
  switch (code) {
    case "el_ws_connect_failed":
      return "el_ws_connect_failed";
    case "el_ws_dropped":
      return "el_ws_dropped";
    case "el_ws_protocol_error":
      return "el_ws_dropped";
    case "el_audio_format_mismatch":
      return "el_ws_dropped";
    case "max_duration_exceeded":
      return "max_duration_exceeded";
    default:
      return "el_ws_dropped";
  }
}

// ─── Call Bridge Class ──────────────────────────────────────────────

export class CallBridge {
  /**
   * @param {object} cfg
   * @param {string} cfg.callId
   * @param {string} cfg.tenantId
   * @param {string} cfg.campaignId
   * @param {string} cfg.contactId
   * @param {string} cfg.campaignContactId
   * @param {string} cfg.agentIdUsed       snapshotted by call-processor
   * @param {number|string} cfg.syncVersionUsed snapshotted by call-processor
   * @param {object} cfg.campaign          { id, name, voice_id, ... }
   * @param {object} cfg.tenant            { id, name, ... }
   * @param {object} cfg.contact           { id, name, phone, custom_fields }
   * @param {object} cfg.supabase          service-role supabase-js client
   * @param {object} cfg.toolContext       passed verbatim to executeToolCall
   * @param {object} cfg.log               pino-compatible logger
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.log = cfg.log && cfg.log.child
      ? cfg.log.child({ component: "call-bridge", callId: cfg.callId })
      : cfg.log;

    this.callId = cfg.callId;
    this.tenantId = cfg.tenantId;
    this.campaignId = cfg.campaignId;
    this.supabase = cfg.supabase;

    this.callStartedAt = new Date();
    this.endedAt = null;

    // Callback set by media-bridge to send slin16 audio back to Asterisk.
    this.sendToAsterisk = null;

    // Lifecycle / state
    this.session = null;
    this.callEndedResolve = null;
    this.endReason = "unknown";
    this.failureReason = null;
    this.finalized = false;
    this.elWsOpenedAt = null;
    this.elWsOpenMs = null;
    this.ttsFirstByteMs = null;
    this.firstAudioReceivedAt = null;

    // Metrics
    this.turnCount = 0;
    this.toolCallCount = 0;
    this.inboundAudioChunks = 0;
    this.outboundAudioChunks = 0;
  }

  /**
   * Start the call bridge. Returns a promise that resolves when the call ends.
   */
  async start() {
    activeBridges.set(this.callId, this);

    return new Promise((resolve) => {
      this.callEndedResolve = resolve;
      // Run async setup; if it fails it will finalize and resolve.
      this._startAsync().catch((err) => {
        this.log && this.log.error && this.log.error({ err }, "call bridge _startAsync threw");
        this._finalizeAndResolve("startup_error", "el_ws_connect_failed");
      });
    });
  }

  async _startAsync() {
    // ── Step 1: CAS assertion against current campaigns row ──────
    // Defense-in-depth: call-processor already snapshotted these values
    // at dequeue time, but a deploy / agent-sync race could still drift
    // before we open the EL WS. We hang up cleanly with
    // agent_version_mismatch (no retry bump per T11.3).
    const agentIdUsed = this.cfg.agentIdUsed;
    const syncVersionUsed = this.cfg.syncVersionUsed;

    if (!agentIdUsed || syncVersionUsed == null) {
      this.log.warn(
        { agentIdUsed, syncVersionUsed },
        "call-bridge missing agent snapshot in cfg — defense-in-depth fail",
      );
      await this._finalizeAndResolve("missing_agent_snapshot", "agent_not_ready");
      return;
    }

    let campaignRow = null;
    try {
      const { data, error } = await this.supabase
        .from("campaigns")
        .select("elevenlabs_agent_id, sync_version, agent_status")
        .eq("id", this.campaignId)
        .single();
      if (error) throw error;
      campaignRow = data;
    } catch (err) {
      this.log.error({ err }, "call-bridge campaign CAS lookup failed");
      await this._finalizeAndResolve("cas_lookup_failed", "network_error");
      return;
    }

    if (
      campaignRow.elevenlabs_agent_id !== agentIdUsed ||
      String(campaignRow.sync_version) !== String(syncVersionUsed) ||
      campaignRow.agent_status !== "ready"
    ) {
      this.log.warn(
        {
          want_agent: agentIdUsed,
          have_agent: campaignRow.elevenlabs_agent_id,
          want_sv: syncVersionUsed,
          have_sv: campaignRow.sync_version,
          status: campaignRow.agent_status,
        },
        "call-bridge agent version mismatch — hanging up",
      );
      await this._finalizeAndResolve("agent_version_mismatch", "agent_version_mismatch");
      return;
    }

    // ── Step 2: Build EL session ──────────────────────────────────
    const dynamicVariables = {
      contact_name: this.cfg.contact?.name || "",
      business_name: this.cfg.tenant?.name || "",
      ...(this.cfg.contact?.custom_fields || {}),
    };

    let session;
    try {
      session = new ElevenLabsSession({
        agentId: agentIdUsed,
        conversationConfig: {
          dynamicVariables,
          // first_message override only if campaign provides one
          ...(this.cfg.campaign?.first_message
            ? { firstMessage: this.cfg.campaign.first_message }
            : {}),
        },
        logger: this.log.child
          ? this.log.child({ component: "el-session", agentId: agentIdUsed })
          : this.log,
      });
    } catch (err) {
      this.log.error({ err }, "ElevenLabsSession constructor threw");
      await this._finalizeAndResolve("el_construct_failed", "el_ws_connect_failed");
      return;
    }

    this.session = session;
    this._wireSessionEvents(session);

    // ── Step 3: Open the WS ──────────────────────────────────────
    this.elWsOpenedAt = Date.now();
    try {
      await session.connect();
    } catch (err) {
      // ElevenLabsSession.connect throws on construct failure; the 'error'
      // event handler we wired above will also fire and finalize. Guard so
      // we don't double-finalize here.
      this.log.error({ err }, "ElevenLabsSession.connect threw");
      if (!this.finalized) {
        await this._finalizeAndResolve("el_connect_failed", "el_ws_connect_failed");
      }
    }
  }

  _wireSessionEvents(session) {
    session.on("conversation_id", async (conversationId) => {
      this.elWsOpenMs = Date.now() - this.elWsOpenedAt;
      this.log.info({ conversationId, elWsOpenMs: this.elWsOpenMs }, "EL conversation_id received");
      try {
        await this.supabase
          .from("calls")
          .update({ elevenlabs_conversation_id: conversationId })
          .eq("id", this.callId);
      } catch (err) {
        this.log.error({ err }, "failed to persist elevenlabs_conversation_id");
      }
    });

    session.on("agent_audio", (buffer) => {
      this.outboundAudioChunks += 1;
      if (!this.firstAudioReceivedAt) {
        this.firstAudioReceivedAt = Date.now();
        this.ttsFirstByteMs = this.firstAudioReceivedAt - this.elWsOpenedAt;
      }
      // EL audio is already PCM16 LE @ 16 kHz (assertion enforced inside the
      // session). slin16 expects exactly the same — no resampling.
      if (this.sendToAsterisk) {
        try {
          this.sendToAsterisk(buffer.toString("base64"));
        } catch (err) {
          this.log.error({ err }, "sendToAsterisk threw");
        }
      }
    });

    session.on("user_transcript", ({ text, isFinal, ts }) => {
      this.turnCount += 1;
      enqueueTurn({
        callId: this.callId,
        tenantId: this.tenantId,
        role: "user",
        text,
        isFinal,
        ts,
      });
    });

    session.on("agent_response", ({ text, ts }) => {
      this.turnCount += 1;
      enqueueTurn({
        callId: this.callId,
        tenantId: this.tenantId,
        role: "agent",
        text,
        isFinal: true,
        ts,
      });
    });

    session.on("agent_response_correction", ({ text, ts }) => {
      // live-turn-writer is append-only; treat correction as another final agent turn.
      this.turnCount += 1;
      enqueueTurn({
        callId: this.callId,
        tenantId: this.tenantId,
        role: "agent",
        text,
        isFinal: true,
        ts,
      });
    });

    session.on("tool_call", async ({ name, args, callId: toolCallId, reply }) => {
      this.toolCallCount += 1;
      this.log.info({ tool: name, toolCallId }, "EL tool_call received");
      try {
        const result = await executeToolCall(name, args, this.cfg.toolContext);
        reply({
          result: typeof result === "string" ? result : JSON.stringify(result ?? null),
          isError: false,
        });
        // end_call tool: allow agent's farewell to play, then close session.
        if (name === "end_call" || (result && result.call_ended)) {
          setTimeout(() => {
            if (!this.finalized) this.endBridge("tool_end_call");
          }, 8000);
        }
      } catch (err) {
        this.log.error({ err, name, args }, "tool execution threw");
        reply({
          result: err && err.message ? err.message : String(err),
          isError: true,
        });
      }
    });

    session.on("error", async (err) => {
      const code = (err && err.code) || "el_ws_protocol_error";
      const reason = mapErrorCodeToFailureReason(code);
      this.log.error({ err, code, reason }, "EL session error");
      if (!this.finalized) {
        await this._finalizeAndResolve("el_session_error", reason);
      }
    });

    session.on("closed", ({ reason }) => {
      this.log.info({ reason }, "EL session closed event");
      // StasisEnd will handle finalization if not already done; do not
      // double-finalize here. The cleanup() / endBridge() path is the
      // single source of truth for the calls row write.
    });
  }

  // ─── Asterisk -> Bridge ────────────────────────────────────────

  /**
   * Handle incoming caller audio from Asterisk via media-bridge.
   * @param {Buffer} audioBuffer slin16 PCM16 16kHz buffer
   */
  handleCallerAudio(audioBuffer) {
    if (!this.session) return;
    if (this.finalized) return;
    this.inboundAudioChunks += 1;
    try {
      this.session.sendAudio(audioBuffer);
    } catch (err) {
      this.log.error({ err }, "session.sendAudio threw");
    }
  }

  // ─── Bridge Lifecycle ───────────────────────────────────────────

  /**
   * Internal end+resolve. Idempotent. Always finalizes the calls row,
   * writes call_metrics, and drains live-turn-writer for this call.
   */
  async _finalizeAndResolve(endReason, failureReason) {
    if (this.finalized) return;
    this.finalized = true;
    this.endReason = endReason;
    this.failureReason = failureReason || null;
    this.endedAt = new Date();

    // Close EL session if still open
    if (this.session) {
      try {
        await this.session.close(endReason);
      } catch (err) {
        this.log.error({ err }, "session.close threw during finalize");
      }
    }

    activeBridges.delete(this.callId);

    // Persist final state to calls row + call_metrics + drain turns.
    try {
      await this._persistFinalState();
    } catch (err) {
      this.log.error({ err }, "persistFinalState threw");
    }

    const result = {
      duration_seconds: Math.max(
        0,
        Math.floor((this.endedAt - this.callStartedAt) / 1000),
      ),
      transcript: [], // canonical transcript lives in call_turns now
      recordingBuffer: null, // EL webhook + audio-archive-processor own recordings
      endReason: this.endReason,
      failureReason: this.failureReason,
      toolCallEndCall: endReason === "tool_end_call",
    };

    const resolve = this.callEndedResolve;
    this.callEndedResolve = null;
    if (resolve) resolve(result);
  }

  async _persistFinalState() {
    const endedIso = this.endedAt.toISOString();

    // DUAL WRITE both failure_reason columns (legacy text + new enum) per
    // T12.4 / spec §3 — old code paths still read failure_reason.
    const update = { ended_at: endedIso };
    if (this.failureReason) {
      update.failure_reason = this.failureReason;
      update.failure_reason_t = this.failureReason;
    }
    try {
      await this.supabase.from("calls").update(update).eq("id", this.callId);
    } catch (err) {
      this.log.error({ err }, "calls update on finalize failed");
    }

    // call_metrics: PRIMARY KEY insert, ignore duplicate (StasisEnd may race
    // with the janitor — both should be safe).
    const metricsRow = {
      call_id: this.callId,
      tenant_id: this.tenantId,
      call_duration_seconds: Math.max(
        0,
        Math.floor((this.endedAt - this.callStartedAt) / 1000),
      ),
      transcript_turn_count: this.turnCount,
      tool_call_count: this.toolCallCount,
      tts_first_byte_ms: this.ttsFirstByteMs,
      el_ws_open_ms: this.elWsOpenMs,
    };
    try {
      await this.supabase
        .from("call_metrics")
        .upsert(metricsRow, { onConflict: "call_id", ignoreDuplicates: true });
    } catch (err) {
      this.log.error({ err }, "call_metrics upsert failed");
    }

    // Drain live-turn-writer buffer for this call.
    try {
      await flushAndClose(this.callId);
    } catch (err) {
      this.log.error({ err }, "flushAndClose failed");
    }
  }

  /**
   * Public end entry point.
   */
  endBridge(reason) {
    if (this.finalized) return;
    // Detached promise — do not block Asterisk event loop.
    this._finalizeAndResolve(reason, this.failureReason).catch((err) => {
      this.log && this.log.error && this.log.error({ err }, "endBridge finalize threw");
    });
  }

  /**
   * External cleanup entry point — called by media-bridge on Asterisk
   * disconnect / StasisEnd. ALWAYS finalizes (§4.4 invariant + §4.8 janitor
   * second line of defense), even if EL session never opened.
   */
  cleanup() {
    if (this.finalized) return;
    this.endBridge("asterisk_disconnect");
  }
}
