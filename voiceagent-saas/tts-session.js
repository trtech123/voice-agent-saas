// voiceagent-saas/tts-session.js
//
// ElevenLabs streaming-input WebSocket adapter for the unbundled voice pipeline.
// Per-turn instance: one TTSSession per agent response. Multiple sentences
// can flow through one session.
//
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §5.3
//
// Wire format (spike-confirmed 2026-04-08):
//   1. WS to /v1/text-to-speech/{voice_id}/stream-input?model_id=...&output_format=pcm_16000
//   2. BOS frame: {text:" ", voice_settings:{...}, xi_api_key:<key>}
//   3. Sentence frames: {text:"... ", try_trigger_generation: true}
//   4. EOS frame: {text:""}
//   5. Inbound: {audio: <base64 PCM16>} chunks + {isFinal: true} terminator

import { EventEmitter } from "events";
import WebSocket from "ws";

const EL_BASE = "wss://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_MODEL = "eleven_turbo_v2_5";
const DEFAULT_OUTPUT_FORMAT = "pcm_16000";
const FIRST_BYTE_TIMEOUT_MS = 5000;
const CONNECT_RETRY_DELAY_MS = 300;

class TTSSessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TTSSessionError";
    this.code = code;
  }
}

export class TTSSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.voiceId
   * @param {object} opts.logger
   * @param {string} [opts.modelId="eleven_turbo_v2_5"]
   * @param {object} [opts.voiceSettings]
   * @param {number} [opts.optimizeStreamingLatency=3]
   */
  constructor({ apiKey, voiceId, logger, modelId, voiceSettings, optimizeStreamingLatency } = {}) {
    super();
    if (!apiKey) throw new Error("TTSSession: apiKey required");
    if (!voiceId) throw new Error("TTSSession: voiceId required");
    if (!logger) throw new Error("TTSSession: logger required");
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.log = logger;
    this.modelId = modelId || DEFAULT_MODEL;
    this.voiceSettings = voiceSettings || { stability: 0.5, similarity_boost: 0.8, speed: 1.0 };
    this.optimizeStreamingLatency = optimizeStreamingLatency ?? 3;

    this.ws = null;
    this._wsOpen = false;
    this._closed = false;
    this._stopped = false;
    this._pendingSentences = [];
    this._totalChars = 0;
    this._firstByteTimer = null;
    this._receivedAnyAudio = false;
  }

  async start() {
    return this._connectWithRetry(0);
  }

  _connectWithRetry(attempt) {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model_id: this.modelId,
        output_format: DEFAULT_OUTPUT_FORMAT,
        optimize_streaming_latency: String(this.optimizeStreamingLatency),
      });
      const url = `${EL_BASE}/${this.voiceId}/stream-input?${params.toString()}`;
      this.log.info({ url, attempt }, "TTS WS connecting");
      let ws;
      try {
        ws = new WebSocket(url, { headers: { "xi-api-key": this.apiKey } });
      } catch (err) {
        reject(new TTSSessionError(`construct: ${err.message}`, "tts_init_failed"));
        return;
      }
      this.ws = ws;

      const onErr = (err) => {
        ws.removeListener("open", onOpen);
        if (attempt < 1) {
          this.log.warn({ err: err.message }, "TTS WS first attempt failed, retrying");
          setTimeout(() => {
            this._connectWithRetry(attempt + 1).then(resolve, reject);
          }, CONNECT_RETRY_DELAY_MS);
          return;
        }
        reject(new TTSSessionError(`tts init failed: ${err.message}`, "tts_init_failed"));
      };
      const onOpen = () => {
        ws.removeListener("error", onErr);
        this._wsOpen = true;
        this.log.info("TTS WS open");
        // Send BOS frame
        const bos = {
          text: " ",
          voice_settings: this.voiceSettings,
          xi_api_key: this.apiKey, // footgun: required in body too per EL protocol
        };
        try {
          ws.send(JSON.stringify(bos));
        } catch (e) {
          reject(new TTSSessionError(`bos send failed: ${e.message}`, "tts_init_failed"));
          return;
        }
        // Wire runtime handlers
        ws.on("message", (data) => this._handleMessage(data));
        ws.on("close", (code, reasonBuf) => {
          if (this._closed || this._stopped) return;
          this.emit("done", { totalChars: this._totalChars });
          this._closed = true;
        });
        ws.on("error", (err) => {
          if (this._closed || this._stopped) return;
          this.log.error({ err: err.message }, "TTS WS runtime error");
          this.emit("error", new TTSSessionError(`runtime: ${err.message}`, "tts_failed"));
        });
        // Drain any pre-open buffered sentences
        this._drainPending();
        resolve();
      };
      ws.once("open", onOpen);
      ws.once("error", onErr);
    });
  }

  _drainPending() {
    while (this._pendingSentences.length > 0) {
      const text = this._pendingSentences.shift();
      this._sendSentenceFrame(text);
    }
  }

  pushSentence(text) {
    if (!text || !text.trim()) return;
    this._totalChars += text.length;
    if (!this._wsOpen) {
      this._pendingSentences.push(text);
      return;
    }
    this._sendSentenceFrame(text);
  }

  _sendSentenceFrame(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ text: text + " ", try_trigger_generation: true }));
    } catch (err) {
      this.log.warn({ err: err.message }, "tts pushSentence send threw");
    }
  }
  finish() { /* filled in Task 4 */ }
  stop() { /* filled in Task 5 */ }
  _handleMessage(data) { /* filled in Task 4 */ }
}

export { TTSSessionError };
