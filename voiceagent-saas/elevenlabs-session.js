// voiceagent-saas/elevenlabs-session.js

/**
 * ElevenLabs Conversational AI WebSocket session.
 *
 * Manages ONE EL Convai WS per active call. Translates Asterisk slin16
 * (PCM 16-bit LE @ 16 kHz) audio frames to/from the EL protocol, surfaces
 * transcripts, tool calls, and lifecycle events, and enforces hard safety
 * timers (10-minute max duration, 30 s heartbeat watchdog).
 *
 * Protocol is pinned verbatim to Appendix A of
 *   docs/superpowers/plans/2026-04-07-elevenlabs-runtime-swap-plan.md
 *
 * NO automatic reconnection — this class is fail-fast. The call-bridge
 * handles retries and failure_reason recording.
 */

import { EventEmitter } from "events";
import WebSocket from "ws";

const EL_WS_BASE = "wss://api.elevenlabs.io/v1/convai/conversation";
const MAX_DURATION_MS = 10 * 60 * 1000;     // 10-minute hard kill switch
const HEARTBEAT_TIMEOUT_MS = 30 * 1000;     // no-message watchdog
const EXPECTED_AUDIO_FORMAT = "pcm_16000";

/** Custom error with machine-readable `code` field for call-bridge routing. */
class ElevenLabsSessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ElevenLabsSessionError";
    this.code = code;
  }
}

export class ElevenLabsSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.agentId              EL agent id (required)
   * @param {object} [opts.conversationConfig] { dynamicVariables, firstMessage }
   * @param {object} opts.logger               pino-compatible logger
   */
  constructor({ agentId, conversationConfig = {}, logger }) {
    super();
    if (!agentId) throw new Error("ElevenLabsSession: agentId is required");
    if (!logger) throw new Error("ElevenLabsSession: logger is required");

    this.apiKey = process.env.ELEVENLABS_API_KEY;
    if (!this.apiKey) {
      throw new Error("ElevenLabsSession: ELEVENLABS_API_KEY env var is required");
    }

    this.agentId = agentId;
    this.conversationConfig = conversationConfig;
    this.log = logger;

    this.ws = null;
    this.conversationId = null;
    this._closed = false;
    this._maxDurationTimer = null;
    this._heartbeatTimer = null;
    this._lastPingAt = null;          // used by downstream tts_first_byte_ms metric
    /** @type {Map<string, {replied: boolean}>} */
    this._pendingToolCalls = new Map();
    this._wsOpen = false;
    this._conversationStarted = false;
  }

  /** Open the WebSocket and send the initiation payload. */
  async connect() {
    const url = `${EL_WS_BASE}?agent_id=${encodeURIComponent(this.agentId)}`;
    this.log.info({ agentId: this.agentId }, "ElevenLabs WS connecting");

    let ws;
    try {
      ws = new WebSocket(url, {
        headers: { "xi-api-key": this.apiKey },
      });
    } catch (err) {
      const e = new ElevenLabsSessionError(
        `EL WS construct failed: ${err.message}`,
        "el_ws_connect_failed"
      );
      this.emit("error", e);
      this.emit("closed", { reason: "el_ws_connect_failed" });
      throw e;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.log.info({ agentId: this.agentId }, "ElevenLabs WS open");
      this._startMaxDurationTimer();
      this._resetHeartbeat();
      this._wsOpen = true;
      this.emit("ws_open");
      // Do NOT send conversation_initiation_client_data here.
      // Caller must invoke startConversation() to start the agent turn.
    });

    ws.on("message", (data) => this._handleMessage(data));

    ws.on("error", (err) => {
      this.log.error({ err }, "ElevenLabs WS error");
      if (this._closed) return;
      const e = new ElevenLabsSessionError(
        `EL WS error: ${err && err.message ? err.message : String(err)}`,
        "el_ws_connect_failed"
      );
      this.emit("error", e);
      this.close("el_ws_error");
    });

    ws.on("close", (code, reasonBuf) => {
      const reason =
        Buffer.isBuffer(reasonBuf) && reasonBuf.length > 0
          ? reasonBuf.toString()
          : `code_${code}`;
      this.log.info({ code, reason }, "ElevenLabs WS closed");
      this._finalize(reason);
    });
  }

  /**
   * Send a PCM 16 kHz 16-bit LE audio frame to the agent.
   * @param {Buffer} pcm16kBuffer
   */
  sendAudio(pcm16kBuffer) {
    if (!this._conversationStarted) {
      // Pre-conversation (ring window) — silently drop. Expected path.
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn("sendAudio called while EL WS not open — dropping frame");
      return;
    }
    const b64 = pcm16kBuffer.toString("base64");
    this._safeSend({
      type: "user_audio_chunk",
      user_audio_chunk: b64,
    });
  }

  /**
   * Begin the EL conversation by sending conversation_initiation_client_data.
   * MUST be called only after the 'ws_open' event has fired.
   * Idempotent: a second call logs a warning and no-ops.
   */
  startConversation() {
    if (this._conversationStarted) {
      this.log.warn("startConversation called twice — ignoring");
      return;
    }
    if (!this._wsOpen) {
      throw new ElevenLabsSessionError(
        "startConversation called before ws_open",
        "el_ws_protocol_error"
      );
    }
    this._conversationStarted = true;
    this._sendInitiation();
  }

  /**
   * Close the session cleanly.
   * @param {string} reason
   */
  async close(reason = "client_close") {
    if (this._closed) return;
    this._finalize(reason);
  }

  // ─── Internal ─────────────────────────────────────────────────────

  _sendInitiation() {
    const cfg = this.conversationConfig || {};
    const agentOverride = {
      language: "he",
    };
    if (cfg.firstMessage) {
      agentOverride.first_message = cfg.firstMessage;
    }
    const payload = {
      type: "conversation_initiation_client_data",
      conversation_config_override: { agent: agentOverride },
      dynamic_variables: cfg.dynamicVariables || {},
    };
    this._safeSend(payload);
  }

  _safeSend(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn({ type: obj && obj.type }, "EL WS send while not open — dropping");
      return;
    }
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.log.error({ err, type: obj && obj.type }, "EL WS send failed");
    }
  }

  _handleMessage(data) {
    this._resetHeartbeat();

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      this.log.error({ err }, "EL WS JSON parse error");
      const e = new ElevenLabsSessionError(
        `EL WS JSON parse error: ${err.message}`,
        "el_ws_protocol_error"
      );
      this.emit("error", e);
      this.close("protocol_error");
      return;
    }

    const type = msg && msg.type;
    switch (type) {
      case "conversation_initiation_metadata": {
        const ev = msg.conversation_initiation_metadata_event || {};
        const convId = ev.conversation_id;
        const fmt = ev.agent_output_audio_format;
        if (fmt !== EXPECTED_AUDIO_FORMAT) {
          const e = new ElevenLabsSessionError(
            `EL agent_output_audio_format=${fmt} (expected ${EXPECTED_AUDIO_FORMAT})`,
            "el_audio_format_mismatch"
          );
          this.emit("error", e);
          this.close("audio_format_mismatch");
          return;
        }
        this.conversationId = convId;
        this.emit("conversation_id", convId);
        break;
      }

      case "audio": {
        const b64 = msg.audio_event && msg.audio_event.audio_base_64;
        if (typeof b64 === "string" && b64.length > 0) {
          const buf = Buffer.from(b64, "base64");
          this.emit("agent_audio", buf);
        }
        break;
      }

      case "user_transcript": {
        const ev = msg.user_transcription_event || {};
        this.emit("user_transcript", {
          text: ev.user_transcript,
          isFinal: Boolean(ev.is_final),
          ts: Date.now(),
        });
        break;
      }

      case "agent_response": {
        const ev = msg.agent_response_event || {};
        this.emit("agent_response", {
          text: ev.agent_response,
          isFinal: true,
          ts: Date.now(),
        });
        break;
      }

      case "agent_response_correction": {
        // EL docs show this with the same shape as agent_response; accept either
        // agent_response_event or agent_response_correction_event for forward-compat.
        const ev =
          msg.agent_response_correction_event ||
          msg.agent_response_event ||
          {};
        this.emit("agent_response_correction", {
          text: ev.agent_response,
          isFinal: true,
          ts: Date.now(),
        });
        break;
      }

      case "client_tool_call": {
        const tc = msg.client_tool_call || {};
        const callId = tc.tool_call_id;
        const name = tc.tool_name;
        const args = tc.parameters || {};
        if (!callId || !name) {
          this.log.warn({ tc }, "EL client_tool_call missing fields");
          break;
        }
        const state = { replied: false };
        this._pendingToolCalls.set(callId, state);
        const reply = ({ result, isError = false } = {}) => {
          if (state.replied) {
            this.log.warn({ callId, name }, "tool_call reply() invoked twice");
            return;
          }
          state.replied = true;
          const serialized =
            typeof result === "string" ? result : JSON.stringify(result ?? null);
          this._safeSend({
            type: "client_tool_result",
            tool_call_id: callId,
            result: serialized,
            is_error: Boolean(isError),
          });
          this._pendingToolCalls.delete(callId);
        };
        this.emit("tool_call", { name, args, callId, reply });
        break;
      }

      case "ping": {
        const ev = msg.ping_event || {};
        this._lastPingAt = Date.now();
        this._safeSend({ type: "pong", event_id: ev.event_id });
        break;
      }

      case "interruption": {
        this.emit("interruption", msg.interruption_event || {});
        break;
      }

      case "vad_score":
      case "internal_tentative_agent_response":
      case "contextual_update":
        // informational / unused in v1
        break;

      default:
        this.log.warn({ type }, "EL WS unknown message type (forward-compat)");
        break;
    }
  }

  _startMaxDurationTimer() {
    if (this._maxDurationTimer) return;
    this._maxDurationTimer = setTimeout(() => {
      this.log.warn("EL session hit 10-minute max duration kill switch");
      const e = new ElevenLabsSessionError(
        "ElevenLabs session exceeded 10-minute maximum duration",
        "max_duration_exceeded"
      );
      e.reason = "max_duration_exceeded";
      this.emit("error", e);
      this.close("max_duration_exceeded");
    }, MAX_DURATION_MS);
  }

  _resetHeartbeat() {
    if (this._closed) return;
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      this.log.warn("EL WS heartbeat watchdog fired (no messages 30s)");
      const e = new ElevenLabsSessionError(
        "ElevenLabs WS dropped (no messages for 30s)",
        "el_ws_dropped"
      );
      this.emit("error", e);
      this.close("el_ws_dropped");
    }, HEARTBEAT_TIMEOUT_MS);
  }

  _finalize(reason) {
    if (this._closed) return;
    this._closed = true;

    if (this._maxDurationTimer) {
      clearTimeout(this._maxDurationTimer);
      this._maxDurationTimer = null;
    }
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    // Warn about any tool calls that never got a reply
    for (const [callId, state] of this._pendingToolCalls.entries()) {
      if (!state.replied) {
        this.log.warn({ callId }, "EL tool_call never replied before session close");
      }
    }
    this._pendingToolCalls.clear();

    if (this.ws) {
      try {
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close(1000, reason);
        }
      } catch (err) {
        this.log.warn({ err }, "EL WS close threw");
      }
      this.ws.removeAllListeners();
      this.ws = null;
    }

    this.emit("closed", { reason });
    this.removeAllListeners();
  }
}
