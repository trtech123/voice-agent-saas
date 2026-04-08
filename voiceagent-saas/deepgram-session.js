// voiceagent-saas/deepgram-session.js
//
// Streaming WebSocket adapter for Deepgram Listen API. Wraps the WS with
// an EventEmitter surface mirroring ElevenLabsSession.
//
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §5.1
//
// Wire format:
//   - Outbound: 20ms slin16 frames (binary WS messages) + KeepAlive text frames
//   - Inbound: Deepgram JSON messages (Results, Metadata, SpeechStarted, UtteranceEnd)
//
// Lifecycle: per-call. One DeepgramSession per active phone call. Constructed
// at call start, connect() before audio flows, finish() at call end.

import { EventEmitter } from "events";
import WebSocket from "ws";

const DG_BASE = "wss://api.deepgram.com/v1/listen";
const KEEPALIVE_INTERVAL_MS = 5000;
const KEEPALIVE_QUIET_THRESHOLD_MS = 4500;
const RECONNECT_BUDGET_MS = 2000;
const RECONNECT_INITIAL_BACKOFF_MS = 100;
const SILENT_DEGRADATION_WARNING_MS = 5000;

class DeepgramSessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DeepgramSessionError";
    this.code = code;
  }
}

export class DeepgramSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey - Deepgram API key
   * @param {object} opts.logger - pino-compatible
   * @param {string} [opts.model="nova-3"] - Deepgram dropped Hebrew from nova-2; nova-3 general is the only Hebrew tier as of 2026-04
   * @param {string} [opts.language="he"]
   */
  constructor({ apiKey, logger, model, language } = {}) {
    super();
    if (!apiKey) throw new Error("DeepgramSession: apiKey required");
    if (!logger) throw new Error("DeepgramSession: logger required");
    this.apiKey = apiKey;
    this.log = logger;
    this.model = model || "nova-3";
    this.language = language || "he";

    this.ws = null;
    this._closed = false;
    this._finishing = false;
    this._lastAudioSentAt = 0;
    this._lastInboundAt = 0;
    this._keepaliveTimer = null;
    this._silentDegradationTimer = null;
    this._reconnectAttempted = false;
  }

  /**
   * Open the Deepgram WS. Returns when the WS is open OR throws on connect failure.
   */
  async connect() {
    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      multichannel: "false",
      interim_results: "true",
      // utterance_end_ms is not supported on Nova-3 WS for any language as of
      // 2026-04-09 (live probe verified — request returns HTTP 400). We
      // synthesize the `utterance_end` event from Results.speech_final=true
      // instead, which Deepgram emits when its internal endpointer fires.
      smart_format: "true",
      vad_events: "true",
    });
    const url = `${DG_BASE}?${params.toString()}`;
    this.log.info({ url }, "Deepgram WS connecting");

    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url, {
          headers: { Authorization: `Token ${this.apiKey}` },
        });
      } catch (err) {
        reject(new DeepgramSessionError(`Deepgram WS construct failed: ${err.message}`, "dg_connect_failed"));
        return;
      }
      this.ws = ws;

      const onOpen = () => {
        this.log.info("Deepgram WS open");
        ws.removeListener("error", onErrorBeforeOpen);
        this._wireRunningHandlers(ws);
        this._startKeepalive();
        this.emit("ws_open");
        resolve();
      };

      const onErrorBeforeOpen = (err) => {
        this.log.error({ err: err.message }, "Deepgram WS error before open");
        ws.removeListener("open", onOpen);
        reject(new DeepgramSessionError(`Deepgram WS connect failed: ${err.message}`, "dg_connect_failed"));
      };

      ws.once("open", onOpen);
      ws.once("error", onErrorBeforeOpen);
    });
  }

  _wireRunningHandlers(ws) {
    ws.on("message", (data, isBinary) => this._handleMessage(data, isBinary));
    ws.on("error", (err) => {
      if (this._closed) return;
      this.log.error({ err: err.message }, "Deepgram WS runtime error");
      this.emit("error", new DeepgramSessionError(`runtime: ${err.message}`, "dg_dropped"));
    });
    ws.on("close", (code, reasonBuf) => {
      if (this._closed) return;
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString() : String(reasonBuf || "");
      if (this._finishing) {
        this.log.info({ code, reason }, "Deepgram WS closed after finish() — not reconnecting");
        return;
      }
      this.log.warn({ code, reason }, "Deepgram WS closed unexpectedly, attempting reconnect");
      this._attemptReconnect();
    });
  }

  _handleMessage(data, isBinary) {
    this._lastInboundAt = Date.now();
    this._cancelSilentDegradationWatchdog();
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const type = msg && msg.type;
    if (type === "Results") {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const text = alt.transcript || "";
      if (!text) return;
      const confidence = typeof alt.confidence === "number" ? alt.confidence : null;
      const isFinal = Boolean(msg.is_final);
      const speechFinal = Boolean(msg.speech_final);
      const evt = { text, confidence, is_final: isFinal, speech_final: speechFinal, ts: Date.now() };
      if (isFinal) this.emit("final", evt);
      else this.emit("partial", evt);
      // Synthesize utterance_end from speech_final since Deepgram Nova-3 WS
      // does not accept utterance_end_ms — see comment in connect().
      if (speechFinal) this.emit("utterance_end", { ts: Date.now() });
      return;
    }
    if (type === "UtteranceEnd") {
      // Defensive: still honor if Deepgram ever starts sending it.
      this.emit("utterance_end", { ts: Date.now() });
      return;
    }
    if (type === "SpeechStarted") {
      this.emit("speech_started", { ts: Date.now() });
      return;
    }
    if (type === "Metadata") {
      // Connection-level info, ignored.
      return;
    }
    // Unknown type — log debug, do not throw.
    this.log.debug({ type }, "deepgram unknown message type");
  }

  _cancelSilentDegradationWatchdog() {
    if (this._silentDegradationTimer) {
      clearTimeout(this._silentDegradationTimer);
      this._silentDegradationTimer = null;
    }
  }

  _startKeepalive() {
    if (this._keepaliveTimer) return;
    this._keepaliveTimer = setInterval(() => {
      if (this._closed) return;
      const sinceLastAudio = Date.now() - this._lastAudioSentAt;
      // Skip if audio was sent within the quiet threshold (the audio
      // itself keeps the connection alive on Deepgram's side).
      if (this._lastAudioSentAt > 0 && sinceLastAudio < KEEPALIVE_QUIET_THRESHOLD_MS) {
        return;
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      } catch (err) {
        this.log.warn({ err: err.message }, "deepgram KeepAlive send threw");
      }
    }, KEEPALIVE_INTERVAL_MS);
  }
  _attemptReconnect() {
    if (this._closed) return;
    if (this._reconnectAttempted) {
      // Second drop = give up.
      this.log.error("Deepgram WS dropped after reconnect — failing call");
      setTimeout(() => {
        if (this._closed) return;
        this.emit("error", new DeepgramSessionError("WS dropped after reconnect", "dg_dropped"));
      }, 0);
      return;
    }
    this._reconnectAttempted = true;
    this.log.warn({ backoffMs: RECONNECT_INITIAL_BACKOFF_MS }, "Deepgram WS reconnecting");

    setTimeout(() => {
      if (this._closed) return;
      // Build a new WS with the same params. Re-running connect() is the
      // simplest way to share the URL/header logic.
      const params = new URLSearchParams({
        model: this.model,
        language: this.language,
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
        multichannel: "false",
        interim_results: "true",
        // utterance_end_ms intentionally omitted — see comment in connect()
        smart_format: "true",
        vad_events: "true",
      });
      const url = `${DG_BASE}?${params.toString()}`;
      let ws;
      try {
        ws = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } });
      } catch (err) {
        this.emit("error", new DeepgramSessionError(`reconnect construct failed: ${err.message}`, "dg_dropped"));
        return;
      }
      this.ws = ws;

      const onErr = (err) => {
        if (this._closed) return;
        ws.removeListener("open", onOpen);
        this.emit("error", new DeepgramSessionError(`reconnect failed: ${err.message}`, "dg_dropped"));
      };
      const onOpen = () => {
        ws.removeListener("error", onErr);
        this.log.info("Deepgram WS reconnected");
        this._wireRunningHandlers(ws);
        this.emit("ws_reopen");
      };
      ws.once("open", onOpen);
      ws.once("error", onErr);
    }, RECONNECT_INITIAL_BACKOFF_MS);
  }

  /**
   * Send a 20ms slin16 frame (640 bytes) as a binary WS message.
   */
  sendAudio(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this._lastAudioSentAt = Date.now();
    try {
      this.ws.send(buffer);
    } catch (err) {
      this.log.warn({ err: err.message }, "deepgram sendAudio threw");
    }
  }

  /**
   * Send a CloseStream message and wait for final transcripts. Used at call end.
   */
  finish() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Mark finishing so the WS close that follows the server's CloseStream
    // ack does not trigger an unwanted reconnect.
    this._finishing = true;
    try {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
    } catch (err) {
      this.log.warn({ err: err.message }, "deepgram finish threw");
    }
  }

  /**
   * Close the session cleanly. Idempotent.
   */
  close(reason = "client_close") {
    if (this._closed) return;
    this._closed = true;
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
    if (this._silentDegradationTimer) {
      clearTimeout(this._silentDegradationTimer);
      this._silentDegradationTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close(1000, reason);
      } catch {}
    }
    this.emit("closed", { reason });
  }
}
