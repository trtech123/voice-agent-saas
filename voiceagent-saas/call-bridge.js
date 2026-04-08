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
import { createSilenceDetector } from "./vad.js";
import {
  VAD_RMS_THRESHOLD,
  VAD_SILENCE_DEBOUNCE_MS,
  VAD_SANITY_GAP_MS,
  VAD_CONSECUTIVE_SILENT_FRAMES,
  VAD_AGENT_AUDIO_TAIL_MS,
} from "./vad-config.js";

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

// ─── Latency Helpers (spec §4.4) ────────────────────────────────────

export function clampNonNegative(n) {
  return typeof n === "number" && n >= 0 ? n : 0;
}

export function mean(arr) {
  if (!arr || arr.length === 0) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

export function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
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

    // State machine (spec 2026-04-08 §2):
    //   created → pre_warming → pre_warmed → live → finalized
    this._state = "created";
    this._stateEnteredAt = Date.now();
    this._pendingCustomerAnswered = false;

    // Metrics
    this.turnCount = 0;
    this.toolCallCount = 0;
    this.inboundAudioChunks = 0;
    this.outboundAudioChunks = 0;

    // Latency tracker (spec §4.1 + VAD spec §4.5)
    this.latency = {
      customerAnsweredAt: null,
      greetingLatencyMs: null,
      lastPartialTranscriptAt: null,
      pendingUserFinalIsBarge: false,
      turnLatenciesMs: [],
      audioPlumbingSamplesMs: [],
      vadFallbackCount: 0,
    };

    // VAD detector (one per call). Echo-gated via setMuted during agent playback.
    this.vad = createSilenceDetector({
      threshold: VAD_RMS_THRESHOLD,
      debounceMs: VAD_SILENCE_DEBOUNCE_MS,
      consecutiveSilentFrames: VAD_CONSECUTIVE_SILENT_FRAMES,
    });
    this._vadUnmuteTimer = null;
  }

  /**
   * Internal state transition helper. Logs every transition and rejects
   * invalid transitions (logs an error and stays in the source state).
   * Never throws — defensive.
   *
   * Valid graph:
   *   created      → pre_warming
   *   pre_warming  → pre_warmed | finalized
   *   pre_warmed   → live       | finalized
   *   live         → finalized
   *   finalized    → (terminal)
   */
  _transition(target, reason) {
    const from = this._state;
    const valid = {
      created: ["pre_warming"],
      pre_warming: ["pre_warmed", "finalized"],
      pre_warmed: ["live", "finalized"],
      live: ["finalized"],
      finalized: [],
    };
    if (!valid[from] || !valid[from].includes(target)) {
      this.log.error(
        { from, to: target, reason },
        "call-bridge: invalid state transition — staying in source state",
      );
      return;
    }
    const now = Date.now();
    const elapsedMs = this._stateEnteredAt ? now - this._stateEnteredAt : 0;
    this._stateEnteredAt = now;
    this._state = target;
    this.log.info(
      {
        event: "call_bridge_state_transition",
        call_id: this.callId,
        from,
        to: target,
        reason,
        elapsed_ms_since_start: elapsedMs,
      },
      "call-bridge state transition",
    );
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
    this._transition("pre_warming", "start_called");
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
    // ws_open fires when the EL WebSocket transport (TCP/TLS/HTTP upgrade)
    // is ready. We transition from pre_warming → pre_warmed here and wait
    // for handleCustomerAnswered() before starting the conversation.
    // If the customer answered faster than the WS handshake completed,
    // _pendingCustomerAnswered will be set and we transition straight to
    // live now (draining the queued pickup event).
    session.on("ws_open", () => {
      this._transition("pre_warmed", "ws_open");
      this.elWsOpenMs = Date.now() - this.elWsOpenedAt;
      if (this._pendingCustomerAnswered) {
        this._pendingCustomerAnswered = false;
        this._transition("live", "customer_answered_early");
        try {
          this.session.startConversation();
        } catch (err) {
          this.log.error(
            { err },
            "startConversation threw during pending-customer flush",
          );
          this._finalizeAndResolve(
            "start_conversation_failed",
            "el_ws_protocol_error",
          );
        }
      }
    });

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
      const receivedAt = Date.now();
      this.outboundAudioChunks += 1;
      if (!this.firstAudioReceivedAt) {
        this.firstAudioReceivedAt = receivedAt;
        this.ttsFirstByteMs = receivedAt - this.elWsOpenedAt;
      }

      // Hot path: dispatch audio FIRST. Instrumentation MUST NOT delay this.
      let sentAt = null;
      if (this.sendToAsterisk) {
        try {
          this.sendToAsterisk(buffer.toString("base64"));
          sentAt = Date.now();
        } catch (err) {
          this.log.error({ err }, "sendToAsterisk threw");
        }
      }

      // Observability (best-effort, wrapped so a throw cannot impact audio).
      try {
        this._recordAgentAudioLatency(receivedAt, sentAt);
      } catch (err) {
        this.log.error({ err }, "latency recording threw");
      }

      // Echo gating (VAD spec §4.5): mute VAD while agent is speaking and
      // for VAD_AGENT_AUDIO_TAIL_MS after. Renewed on every outbound chunk.
      // Must run AFTER _recordAgentAudioLatency so the first chunk's turn
      // latency uses the pre-mute VAD state from the user's last turn.
      try {
        this.vad.setMuted(true);
        if (this._vadUnmuteTimer) clearTimeout(this._vadUnmuteTimer);
        this._vadUnmuteTimer = setTimeout(() => {
          this._vadUnmuteTimer = null;
          try {
            this.vad.setMuted(false);
          } catch (err) {
            this.log.error({ err }, "vad.setMuted(false) threw");
          }
        }, VAD_AGENT_AUDIO_TAIL_MS);
      } catch (err) {
        this.log.error({ err }, "echo gating threw");
      }
    });

    session.on("user_transcript", ({ text, isFinal, ts }) => {
      // VAD spec §4.5: every partial updates the fallback anchor.
      // No gating on isFinal — the current agent config never sets it.
      this.latency.lastPartialTranscriptAt = Date.now();

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

    session.on("interruption", () => {
      // VAD spec §4.5: set barge flag only if at least one anchor
      // is available (RMS VAD finalized a stop, OR EL sent a partial).
      // Otherwise this is a pure agent-turn barge with nothing to
      // poison, so we no-op to prevent cross-turn flag leaks.
      if (
        this.vad.getUserStoppedAt() != null ||
        this.latency.lastPartialTranscriptAt != null
      ) {
        this.latency.pendingUserFinalIsBarge = true;
      }
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

  /**
   * Record latency for one agent_audio chunk. Called AFTER sendToAsterisk
   * from inside the agent_audio handler. Best-effort — caller wraps in
   * try/catch so throws cannot impact audio dispatch.
   *
   * Handles two sample paths:
   *   1. Greeting first chunk: computes greeting_latency_ms (once per call).
   *   2. Turn first chunk: computes turn_latency_ms via VAD + EL-partial
   *      hybrid anchor selection (VAD spec §4.2, §4.5). The sanity-gap
   *      rule rejects RMS VAD output that is far later than EL's last
   *      partial (indicating noise held RMS above threshold after the
   *      user actually stopped).
   *   3. Barge-in case: discards the turn sample if pendingUserFinalIsBarge.
   *
   * audio_plumbing_ms samples (sentAt - receivedAt) are pushed on the
   * greeting first chunk AND on non-barge turn first chunks. The VAD
   * reset at the end of the turn path ensures subsequent chunks within
   * the same agent response do not double-count.
   *
   * Spec §3.1, §3.3, §4.2; VAD spec §4.5, §4.2.
   */
  _recordAgentAudioLatency(receivedAt, sentAt) {
    // Greeting path
    if (this.latency.greetingLatencyMs == null) {
      if (this.latency.customerAnsweredAt != null) {
        const gl = clampNonNegative(receivedAt - this.latency.customerAnsweredAt);
        this.latency.greetingLatencyMs = gl;
        if (sentAt != null) {
          this.latency.audioPlumbingSamplesMs.push(
            clampNonNegative(sentAt - receivedAt),
          );
        }
        this.log.info(
          {
            event: "greeting_latency",
            call_id: this.callId,
            greeting_latency_ms: gl,
          },
          "greeting latency measured",
        );
        return;
      }
      // Defensive: agent_audio arrived but we never got customer_answered.
      // Only warn if state is live (to skip expected early-media / ringback
      // frames during pre_warmed). Should not happen post-lifecycle-fix.
      if (this._state === "live") {
        this.log.warn(
          { event: "greeting_latency_skipped_no_answer", call_id: this.callId },
          "agent_audio before customer_answered — greeting_latency not computed",
        );
      }
      return;
    }

    // Turn path — VAD spec §4.5
    this.vad.resolvePending(receivedAt);
    const userStoppedAtRms = this.vad.getUserStoppedAt();
    const lastPartial = this.latency.lastPartialTranscriptAt;

    let userStoppedAt = null;
    let source = null;
    if (userStoppedAtRms != null && lastPartial != null) {
      if (userStoppedAtRms - lastPartial > VAD_SANITY_GAP_MS) {
        // RMS said the user stopped much later than EL's last partial —
        // noise held the RMS above threshold after real speech ended.
        // Trust EL's partial.
        userStoppedAt = lastPartial;
        source = "el_partial_fallback";
        this.latency.vadFallbackCount += 1;
      } else {
        userStoppedAt = userStoppedAtRms;
        source = "rms_vad";
      }
    } else if (userStoppedAtRms != null) {
      userStoppedAt = userStoppedAtRms;
      source = "rms_vad";
    } else if (lastPartial != null) {
      userStoppedAt = lastPartial;
      source = "el_partial_fallback";
      this.latency.vadFallbackCount += 1;
    }

    if (userStoppedAt == null) {
      // No anchor — skip the sample entirely.
      this.log.debug(
        {
          event: "turn_latency_skipped_no_anchor",
          call_id: this.callId,
        },
        "turn latency skipped (no anchor available)",
      );
      this.vad.reset();
      this.latency.lastPartialTranscriptAt = null;
      this.latency.pendingUserFinalIsBarge = false;
      return;
    }

    if (this.latency.pendingUserFinalIsBarge) {
      this.log.info(
        {
          event: "turn_latency_skipped_barge",
          call_id: this.callId,
        },
        "turn latency discarded (barge)",
      );
      this.vad.reset();
      this.latency.lastPartialTranscriptAt = null;
      this.latency.pendingUserFinalIsBarge = false;
      return;
    }

    const tl = clampNonNegative(receivedAt - userStoppedAt);
    this.latency.turnLatenciesMs.push(tl);
    if (sentAt != null) {
      this.latency.audioPlumbingSamplesMs.push(
        clampNonNegative(sentAt - receivedAt),
      );
    }
    this.log.info(
      {
        event: "turn_latency",
        call_id: this.callId,
        turn_index: this.latency.turnLatenciesMs.length,
        user_stopped_at: userStoppedAt,
        agent_audio_at: receivedAt,
        turn_latency_ms: tl,
        source,
      },
      "turn latency measured",
    );
    this.vad.reset();
    this.latency.lastPartialTranscriptAt = null;
    this.latency.pendingUserFinalIsBarge = false;
  }

  // ─── Asterisk -> Bridge ────────────────────────────────────────

  /**
   * Signal from server.js that the customer has picked up the phone
   * (ARI ChannelStateChange → Up on the customer channel). Transitions
   * the bridge from PRE_WARMED → LIVE and tells the EL session to
   * begin the conversation.
   *
   * Idempotent: a second call logs a warning and no-ops.
   * If called during PRE_WARMING (race where the customer answered
   * faster than the WS handshake), the transition is queued and the
   * ws_open handler will complete it.
   * If called after FINALIZED, the call logs a warning and is a no-op.
   *
   * Spec: docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md §3.2
   */
  handleCustomerAnswered() {
    // Spec §3.1, §4.2: stamp unconditionally at method entry so that a
    // call during PRE_WARMING (queued via _pendingCustomerAnswered) still
    // captures the user's subjective "I answered the phone" moment.
    // Guarded to not re-stamp on idempotent second calls.
    if (this.latency.customerAnsweredAt == null) {
      this.latency.customerAnsweredAt = Date.now();
    }

    if (this._state === "live") {
      this.log.warn("handleCustomerAnswered called twice — ignoring");
      return;
    }
    if (this._state === "finalized") {
      this.log.warn("handleCustomerAnswered after finalize — ignoring");
      return;
    }
    if (this._state === "pre_warming") {
      // Race: customer answered before WS handshake finished.
      // Queue the transition; the ws_open handler will pick it up.
      this._pendingCustomerAnswered = true;
      return;
    }
    if (this._state !== "pre_warmed") {
      this.log.error(
        { state: this._state },
        "handleCustomerAnswered in unexpected state",
      );
      return;
    }
    this._transition("live", "customer_answered");
    try {
      this.session.startConversation();
    } catch (err) {
      this.log.error(
        { err },
        "startConversation threw in handleCustomerAnswered",
      );
      this._finalizeAndResolve(
        "start_conversation_failed",
        "el_ws_protocol_error",
      );
    }
  }

  /**
   * Handle incoming caller audio from Asterisk via media-bridge.
   * @param {Buffer} audioBuffer slin16 PCM16 16kHz buffer
   */
  handleCallerAudio(audioBuffer) {
    if (this._state !== "live") {
      // Drop ringback / early-media frames (CREATED / PRE_WARMING /
      // PRE_WARMED states) and any frames that arrive after FINALIZED.
      return;
    }
    this.inboundAudioChunks += 1;
    try {
      this.session.sendAudio(audioBuffer);
    } catch (err) {
      this.log.error({ err }, "session.sendAudio threw");
    }

    // VAD fed AFTER sendAudio so a VAD throw cannot delay forwarding.
    try {
      this.vad.pushChunk(audioBuffer, Date.now());
    } catch (err) {
      this.log.error({ err }, "vad.pushChunk threw");
    }
  }

  // ─── Bridge Lifecycle ───────────────────────────────────────────

  /**
   * Internal end+resolve. Idempotent. Always finalizes the calls row,
   * writes call_metrics, and drains live-turn-writer for this call.
   */
  async _finalizeAndResolve(endReason, failureReason) {
    if (this._state === "finalized") return;
    // Drive the state machine into the terminal state. The transition helper
    // accepts any source state → finalized (per the valid graph in _transition).
    this._transition("finalized", endReason || "finalize");
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

    // Clear the VAD unmute timer so a stale timer cannot fire after
    // the bridge ends (VAD spec §5).
    if (this._vadUnmuteTimer) {
      clearTimeout(this._vadUnmuteTimer);
      this._vadUnmuteTimer = null;
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

    // call_metrics: primary-key upsert. Bridge path is last-writer-wins
    // (ignoreDuplicates: false) so bridge writes always land even when
    // the janitor raced first with a sparse row. The janitor path at
    // janitor.js:112 stays ignoreDuplicates: true so it no-ops when a
    // row already exists — preventing the inverse race. See spec §4.6.
    let latencyFields = {};
    try {
      const turns = this.latency.turnLatenciesMs;
      const plumbing = this.latency.audioPlumbingSamplesMs;
      const avgTurn = mean(turns);
      const avgPlumbing = mean(plumbing);
      latencyFields = {
        greeting_latency_ms: this.latency.greetingLatencyMs,
        avg_turn_latency_ms: avgTurn != null ? Math.round(avgTurn) : null,
        p95_turn_latency_ms: percentile(turns, 0.95),
        audio_plumbing_ms: avgPlumbing != null ? Math.round(avgPlumbing) : null,
        turn_latencies_ms: turns && turns.length ? turns : null,
        vad_fallback_count: this.latency.vadFallbackCount || 0,
      };
    } catch (err) {
      this.log.error({ err }, "latency aggregation threw");
      latencyFields = {};
    }

    // End-of-call latency summary log (spec §4.3).
    try {
      this.log.info(
        {
          event: "call_latency_summary",
          call_id: this.callId,
          greeting_latency_ms: latencyFields.greeting_latency_ms ?? null,
          turn_count: Array.isArray(this.latency.turnLatenciesMs)
            ? this.latency.turnLatenciesMs.length
            : 0,
          avg_turn_latency_ms: latencyFields.avg_turn_latency_ms ?? null,
          p95_turn_latency_ms: latencyFields.p95_turn_latency_ms ?? null,
          audio_plumbing_ms: latencyFields.audio_plumbing_ms ?? null,
          vad_fallback_count: latencyFields.vad_fallback_count ?? null,
        },
        "call latency summary",
      );
    } catch (err) {
      this.log.error({ err }, "call_latency_summary log failed");
    }

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
      ...latencyFields,
    };
    try {
      await this.supabase
        .from("call_metrics")
        .upsert(metricsRow, { onConflict: "call_id", ignoreDuplicates: false });
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
