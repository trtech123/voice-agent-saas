// voiceagent-saas/unbundled-pipeline.js
//
// Orchestrator for the unbundled voice pipeline. Drop-in replacement for
// ElevenLabsSession in call-bridge.js when campaign.voice_pipeline === 'unbundled'.
//
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §3.4, §4, §5.4
//
// Owns:
//   - one DeepgramSession (per call)
//   - per-turn LLMSession instances
//   - per-turn TTSSession instances
//   - in-memory dialogue history (sliding window of last 20 turns)
//   - the barge gate
//   - the tool-call loop with filler audio
//   - boot-synthesized filler ("רגע אחד") and error TTS phrases
//   - the call-level FSM
//
// Emits the same EventEmitter surface as ElevenLabsSession so call-bridge.js
// can branch with a single line.

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { DeepgramSession } from "./deepgram-session.js";
import { LLMSession } from "./llm-session.js";
import { TTSSession } from "./tts-session.js";
import { buildOpenAIToolSchema } from "./tools.js";
import { executeToolCall } from "./tools.js";
import { buildFromCampaign } from "./agent-prompt.js";

// FSM states
const STATE = {
  IDLE: "idle",
  CONNECTED: "connected",
  GREETING: "greeting",
  LISTENING: "listening",
  PROCESSING: "processing",
  TOOL_RUNNING: "tool_running",
  FILLER_AUDIO: "filler_audio",
  SPEAKING: "speaking",
  BARGING: "barging",
  CLOSED: "closed",
};

// Tunables (from env, with defaults from the spec)
const env = (k, d) => {
  const v = process.env[k];
  if (v == null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const DEEPGRAM_BARGE_GATE_MS = env("DEEPGRAM_BARGE_GATE_MS", 150);
const LLM_MAX_ROUNDS_PER_CALL = env("LLM_MAX_ROUNDS_PER_CALL", 50);
const LLM_HISTORY_WINDOW_TURNS = env("LLM_HISTORY_WINDOW_TURNS", 20);
const BARGE_LOOP_THRESHOLD = env("BARGE_LOOP_THRESHOLD", 5);
const BARGE_LOOP_WINDOW_MS = env("BARGE_LOOP_WINDOW_MS", 30_000);
const MAX_DURATION_MS = 10 * 60 * 1000;
const FILLER_DELAY_MS = 500;
const TOOL_EXEC_TIMEOUT_MS = 30_000;
const BARGE_GATE_MIN_CHARS = 3;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "9i2kmIrFwyBhu8sTYm07";

class UnbundledPipelineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "UnbundledPipelineError";
    this.code = code;
  }
}

// ─── Boot-synthesized audio cache ────────────────────────────────────────
//
// Pre-synthesized once at module load. Played zero-latency during tool calls
// (filler) or on most failure paths (error TTS).

let _bootSynthesisDone = false;
let _fillerPcm = Buffer.alloc(0);
let _errorPcm = Buffer.alloc(0);

const FILLER_TEXT = "רגע אחד";
const ERROR_TEXT = "סליחה, יש לי בעיה טכנית, אני מתקשר שוב מאוחר יותר";

async function bootSynthesizeOnce(apiKey, logger) {
  if (_bootSynthesisDone) return;
  _bootSynthesisDone = true;
  try {
    _fillerPcm = await synthesizeOneShot(apiKey, FILLER_TEXT, logger);
    _errorPcm = await synthesizeOneShot(apiKey, ERROR_TEXT, logger);
    logger.info(
      { fillerBytes: _fillerPcm.length, errorBytes: _errorPcm.length },
      "unbundled boot synthesis complete",
    );
  } catch (err) {
    logger.warn({ err: err.message }, "unbundled boot synthesis failed (fallback to silence)");
  }
}

async function synthesizeOneShot(apiKey, text, logger) {
  // Use the EL HTTP /stream endpoint (NOT WebSocket) — simpler one-shot.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=pcm_16000`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1.0 },
    }),
  });
  if (!res.ok) throw new Error(`EL HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ─── The orchestrator class ──────────────────────────────────────────────

export class UnbundledPipeline extends EventEmitter {
  constructor({ tenantId, callId, campaign, contact, tenant, apiKeys, logger, toolContext } = {}) {
    super();
    if (!callId) throw new Error("UnbundledPipeline: callId required");
    if (!apiKeys?.deepgram) throw new Error("UnbundledPipeline: deepgram apiKey required");
    if (!apiKeys?.openai) throw new Error("UnbundledPipeline: openai apiKey required");
    if (!apiKeys?.elevenlabs) throw new Error("UnbundledPipeline: elevenlabs apiKey required");
    if (!logger) throw new Error("UnbundledPipeline: logger required");

    this.tenantId = tenantId;
    this.callId = callId;
    this.campaign = campaign;
    this.contact = contact;
    this.tenant = tenant;
    this.apiKeys = apiKeys;
    this.log = logger;
    this.toolContext = toolContext || {};

    // Identifier reused as 'voice session id' for log + DB compatibility
    this.conversationId = randomUUID();

    this._state = STATE.IDLE;
    this._closed = false;
    this._maxDurationTimer = null;

    // Adapters
    this._dg = null;
    this._currentLlm = null;
    this._currentTts = null;
    this._currentLlmAbort = null;
    this._currentToolPromise = null;

    // Dialogue
    this._messages = [];
    this._toolFailureCounts = new Map();

    // Latency / observability
    this._roundCountThisCall = 0;
    this._bargeTimestamps = [];
    this._lastTtsAudioAt = 0;

    // Counters surfaced to call-bridge for call_metrics
    this.metrics = {
      sttFirstPartialMsSamples: [],
      llmFirstTokenMsSamples: [],
      llmFirstSentenceMsSamples: [],
      ttsFirstByteMsSamples: [],
      totalTurnLatencyMsSamples: [],
      bargeCount: 0,
      bargeResponseMs: 0,
      dgReconnectCount: 0,
      toolCallCount: 0,
      toolCallMaxMs: 0,
      llmTokensIn: 0,
      llmTokensOut: 0,
      llmCostUsdMicros: 0,
      sttAudioSeconds: 0,
      ttsCharsSynthesized: 0,
    };
  }

  /** Open Deepgram WS, run boot synthesis (once per process), prepare. */
  async connect() {
    if (this._state !== STATE.IDLE) {
      this.log.warn({ state: this._state }, "connect() called in non-IDLE state");
      return;
    }
    // Boot synthesis (once per process; cheap subsequent calls)
    await bootSynthesizeOnce(this.apiKeys.elevenlabs, this.log);

    // Install max-duration kill switch
    this._maxDurationTimer = setTimeout(() => {
      this.log.warn("unbundled max duration kill switch fired");
      this.emit("error", new UnbundledPipelineError("max duration", "max_duration_exceeded"));
      this.close("max_duration_exceeded");
    }, MAX_DURATION_MS);

    // Open Deepgram session
    this._dg = new DeepgramSession({
      apiKey: this.apiKeys.deepgram,
      logger: this.log.child ? this.log.child({ component: "dg" }) : this.log,
    });
    this._wireDeepgramHandlers();
    try {
      await this._dg.connect();
    } catch (err) {
      this.log.error({ err: err.message }, "deepgram connect failed");
      this.emit("error", new UnbundledPipelineError("stt init failed", "stt_init_failed"));
      throw err;
    }

    this._setState(STATE.CONNECTED);
    this.emit("ws_open");
    this.emit("conversation_id", this.conversationId);
  }

  _wireDeepgramHandlers() {
    this._dg.on("partial", (e) => this._onDeepgramPartial(e));
    this._dg.on("final", (e) => this._onDeepgramFinal(e));
    this._dg.on("utterance_end", (e) => this._handleUtteranceEndFailover(e));
    this._dg.on("ws_reopen", () => {
      this.metrics.dgReconnectCount += 1;
      this.log.info("deepgram reconnected mid-call");
    });
    this._dg.on("error", (err) => {
      this.log.error({ err: err.message, code: err.code }, "deepgram error");
      this.emit("error", new UnbundledPipelineError(err.message, "stt_dropped"));
      this.close("stt_dropped");
    });
  }

  _onDeepgramPartial(evt) {
    // Stash latest partial for the next turn-commit + evaluate barge gate.
    this._latestPartialText = evt.text;
    this._latestPartialAt = evt.ts;
    if (this._state === STATE.SPEAKING || this._state === STATE.PROCESSING) {
      this._evaluateBargeGate(evt);
    }
  }

  _onDeepgramFinal(evt) {
    this._latestPartialText = evt.text;
    this._latestPartialAt = evt.ts;
  }

  /** Begin the conversation: synthesize the greeting and inject as turn 0. */
  async startConversation() {
    // Filled in by Task 3.
  }

  /** Forward a 20ms slin16 frame to Deepgram. */
  sendAudio(buffer) {
    if (this._dg) this._dg.sendAudio(buffer);
  }

  /** Called by call-bridge when our VAD commits a user turn. */
  async commitUserTurn(source) {
    // Filled in by Task 4-7.
  }

  /** Called when Deepgram emits utterance_end (failover). */
  _handleUtteranceEndFailover() {
    // Filled in by Task 4.
  }

  /** Called by Deepgram partial handler — evaluates the barge gate. */
  _evaluateBargeGate(partial) {
    // Filled in by Task 8.
  }

  /** Clean up everything. Idempotent. */
  async close(reason = "client_close") {
    if (this._closed) return;
    this._closed = true;
    this._setState(STATE.CLOSED);
    if (this._maxDurationTimer) {
      clearTimeout(this._maxDurationTimer);
      this._maxDurationTimer = null;
    }
    if (this._currentLlmAbort) {
      try { this._currentLlmAbort.abort(); } catch {}
    }
    if (this._currentTts) {
      try { this._currentTts.stop(); } catch {}
    }
    if (this._currentToolPromise) {
      // Wait up to 5s for the tool to settle so DB writes don't race finalize.
      try {
        await Promise.race([
          this._currentToolPromise,
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      } catch {}
    }
    if (this._dg) {
      try { this._dg.close(reason); } catch {}
    }
    this.emit("closed", { reason });
  }

  // Same name as ElevenLabsSession.startConversation for API parity.
  // call-bridge.js calls this method.
  // (it's the same as startConversation above, kept for symmetry)

  // ─── Internal helpers ──────────────────────────────────────────────

  _setState(next) {
    const prev = this._state;
    if (prev === next) return;
    this._state = next;
    this.log.info(
      { event: "unbundled_state_transition", from: prev, to: next, call_id: this.callId },
      "unbundled state transition",
    );
  }
}

export { UnbundledPipelineError, bootSynthesizeOnce };
