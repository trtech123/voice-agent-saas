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

  async start() { /* filled in Task 2 */ }
  pushSentence(text) { /* filled in Task 3 */ }
  finish() { /* filled in Task 4 */ }
  stop() { /* filled in Task 5 */ }
  _handleMessage(data) { /* filled in Task 4 */ }
}

export { TTSSessionError };
