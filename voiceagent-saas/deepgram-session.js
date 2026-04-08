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
   * @param {string} [opts.model="nova-2"] - falls back to nova-2 if not specified
   * @param {string} [opts.language="he"]
   */
  constructor({ apiKey, logger, model, language } = {}) {
    super();
    if (!apiKey) throw new Error("DeepgramSession: apiKey required");
    if (!logger) throw new Error("DeepgramSession: logger required");
    this.apiKey = apiKey;
    this.log = logger;
    this.model = model || "nova-2";
    this.language = language || "he";

    this.ws = null;
    this._closed = false;
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
      utterance_end_ms: "700",
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
      this.log.warn({ code, reason }, "Deepgram WS closed unexpectedly, attempting reconnect");
      this._attemptReconnect();
    });
  }

  _handleMessage(data, isBinary) {
    this._lastInboundAt = Date.now();
    if (isBinary) return; // Deepgram does not send binary
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // Filled in by Task 3.
  }

  _startKeepalive() { /* filled in by Task 4 */ }
  _attemptReconnect() { /* filled in by Task 5 */ }

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
