// voiceagent-saas/call-bridge.js

/**
 * Call Bridge — Audio bridge between Asterisk (slin16) and Gemini Live AI.
 *
 * Ported from apps/voice-engine/src/call-bridge.ts for merged deployment.
 *
 * Carried over from FlyingCarpet:
 * - NO_INTERRUPTION mode (prevents Gemini deaf session bug)
 * - Two-tiered watchdog: Track 1 (deaf detection), Track 2 (idle nudge)
 * - Watchdog reconnect with conversation history replay (max 2 reconnects)
 * - Half-duplex audio management (suppress caller during agent speech)
 * - Server-side hallucination detection + correction injection (max 1 per call)
 * - VAD reset silence injection on gate lift
 *
 * Changes from TS version:
 * - handleCallerAudio accepts raw Buffer (slin16 PCM16 16kHz from Asterisk)
 * - handleGeminiAudio uses downsample24kTo16k instead of geminiPcmToUlaw
 * - sendToAsterisk callback (set by media-bridge) replaces voicenterClient.sendAudio
 * - RMS computed on raw Buffer, throttled to every 3rd chunk
 * - All TypeScript types/interfaces/access modifiers removed
 * - Imports from local ./audio-utils.js, ./gemini-session.js, ./tools.js, ./agent-prompt.js
 */

import { GeminiSession, MAX_GEMINI_RECONNECTS } from "./gemini-session.js";
import { executeToolCall } from "./tools.js";
import {
  computeRms,
  createSilenceBuffer,
  SPEECH_RMS_THRESHOLD,
  slin16ToGeminiPcm,
  downsample24kTo16k,
} from "./audio-utils.js";
import {
  buildSystemPrompt,
  buildGreetingInstruction,
  buildReconnectInstruction,
  buildIdleNudgeInstruction,
  buildHallucinationCorrectionInstruction,
} from "./agent-prompt.js";

// ─── Constants (from FC, configurable via env) ──────────────────────

const HALF_DUPLEX_RELEASE_MS = Number(process.env.GEMINI_HALF_DUPLEX_RELEASE_MS || 200);
const TOOL_RESPONSE_SUPPRESS_MS = Number(process.env.TOOL_RESPONSE_SUPPRESS_MS || 3000);
const POST_TOOL_AUDIO_GATE_MAX_MS = Number(process.env.POST_TOOL_AUDIO_GATE_MAX_MS || 10000);
const POST_GENERATION_PLAYBACK_TAIL_MS = Number(process.env.POST_GENERATION_PLAYBACK_TAIL_MS || 1000);
const WATCHDOG_SPEECH_DEAF_SEC = Number(process.env.GEMINI_WATCHDOG_SPEECH_DEAF_SEC || 10);
const WATCHDOG_IDLE_NUDGE_SEC = Number(process.env.GEMINI_WATCHDOG_IDLE_NUDGE_SEC || 25);
const WATCHDOG_INTERVAL_MS = 2000;
const MAX_IDLE_NUDGES = 3;
const VAD_RESET_SILENCE_MS = Number(process.env.GEMINI_VAD_RESET_SILENCE_MS || 300);
const VAD_RESET_SILENCE_BUF = createSilenceBuffer(VAD_RESET_SILENCE_MS, 16000);
const CALL_HARD_TIMEOUT_MS = Number(process.env.CALL_HARD_TIMEOUT_MS || 300000); // 5 min

// ─── Active Bridge Tracking ─────────────────────────────────────────

const activeBridges = new Map();

export function getActiveBridgeCount() {
  return activeBridges.size;
}

export function getActiveBridge(callId) {
  return activeBridges.get(callId);
}

export function cleanupAllBridges() {
  for (const [callId, bridge] of activeBridges) {
    bridge.endBridge("server_shutdown");
  }
}

// ─── Call Bridge Class ──────────────────────────────────────────────

export class CallBridge {
  constructor(cfg) {
    this.cfg = cfg;
    this.log = cfg.log.child
      ? cfg.log.child({ component: "call-bridge", callId: cfg.callId })
      : cfg.log;
    this.callStartedAt = Date.now();

    // Callback set by media-bridge to send audio back to Asterisk
    this.sendToAsterisk = null;

    // Half-duplex state (from FC)
    this.geminiSpeaking = false;
    this.protectedAssistantTurnActive = false;
    this.protectedAssistantTurnCount = 0;
    this.suppressCallerAudioUntil = 0;
    this.postToolOutputGateUntil = 0;
    this.audioWasGated = false;

    // Audio counters
    this.inboundAudioChunkCount = 0;
    this.outboundAudioChunkCount = 0;
    this.suppressedInboundChunkCount = 0;
    this.audioChunksSentInCurrentTurn = 0;
    this.rmsCheckCounter = 0; // throttle RMS to every 3rd chunk

    // Transcript
    this.conversationTranscriptParts = [];
    this.currentTurnTranscript = "";

    // Watchdog state (two-tiered, from FC)
    this.watchdogTimer = null;
    this.speechMsSinceLastOutput = 0;
    this.lastSpeechChunkAt = 0;
    this.silentGapMs = 0;
    this.lastTurnCompleteAt = 0;
    this.idleNudgeSent = false;
    this.idleNudgeCount = 0;

    // Reconnect state
    this.geminiReconnectCount = 0;
    this.reconnectInProgress = false;
    this.lastToolResponsePayload = null;

    // Hallucination detection
    this.correctionInjectionsUsed = 0;
    this.correctionCheckedThisTurn = false;
    this.lastToolCallCompletedAtTurn = 0;

    // Tool call state
    this.toolCallActive = false;

    // Lifecycle
    this.hasSentGreeting = false;
    this.callEndedResolve = null;
    this.endReason = "unknown";
    this.toolCallEndCall = false;
    this.hardTimeoutTimer = null;
    this.recordingChunks = [];

    // Build dynamic system prompt
    const systemPrompt = buildSystemPrompt(
      cfg.campaign,
      cfg.tenant,
      cfg.contact
    );

    // Create Gemini session with event handlers
    this.gemini = new GeminiSession(
      { systemPrompt },
      {
        onSetupComplete: () => this.handleGeminiReady(),
        onAudio: (data, mime) => this.handleGeminiAudio(data, mime),
        onInputTranscription: (text) => this.handleInputTranscription(text),
        onOutputTranscription: (text) => this.handleOutputTranscription(text),
        onTurnComplete: () => this.handleTurnComplete(),
        onGenerationComplete: () => this.handleGenerationComplete(),
        onInterrupted: () => this.handleInterrupted(),
        onToolCall: (calls) => this.handleToolCalls(calls),
        onError: (error) => this.handleGeminiError(error),
        onClose: (code, reason) => this.handleGeminiClose(code, reason),
      },
      this.log
    );
  }

  /**
   * Start the call bridge. Returns a promise that resolves when the call ends.
   */
  async start() {
    activeBridges.set(this.cfg.callId, this);

    return new Promise((resolve) => {
      this.callEndedResolve = resolve;

      // Hard timeout — 5 minutes max per call
      this.hardTimeoutTimer = setTimeout(() => {
        this.log.warn("Hard timeout reached (5 min), forcing call cleanup");
        this.endBridge("hard_timeout");
      }, CALL_HARD_TIMEOUT_MS);

      // Start Gemini session
      this.gemini.connect();

      // Start watchdog
      this.startWatchdog();
    });
  }

  // ─── Asterisk -> Bridge Handlers ──────────────────────────────────

  /**
   * Handle incoming caller audio from Asterisk via media-bridge.
   * @param {Buffer} audioBuffer - Raw slin16 PCM16 16kHz buffer from Asterisk
   */
  handleCallerAudio(audioBuffer) {
    if (!this.gemini.isReady || !this.gemini.isOpen) return;

    const now = Date.now();

    // Half-duplex gating — suppress caller audio during agent speech
    if (
      this.protectedAssistantTurnActive ||
      now < this.suppressCallerAudioUntil ||
      now < this.postToolOutputGateUntil
    ) {
      this.suppressedInboundChunkCount += 1;
      this.audioWasGated = true;
      return;
    }

    // VAD reset silence injection on gate lift
    if (this.audioWasGated) {
      this.audioWasGated = false;
      this.gemini.sendAudio(
        VAD_RESET_SILENCE_BUF.toString("base64"),
        "audio/pcm;rate=16000"
      );
    }

    this.inboundAudioChunkCount += 1;

    // RMS-based speech detection for watchdog — throttled to every 3rd chunk
    this.rmsCheckCounter += 1;
    if (this.rmsCheckCounter >= 3) {
      this.rmsCheckCounter = 0;
      const rms = computeRms(audioBuffer);
      if (rms >= SPEECH_RMS_THRESHOLD) {
        const elapsed = this.lastSpeechChunkAt > 0
          ? Math.min(now - this.lastSpeechChunkAt, 30)
          : 20;
        this.speechMsSinceLastOutput += elapsed;
        this.lastSpeechChunkAt = now;
        this.silentGapMs = 0;
        this.lastTurnCompleteAt = 0; // Caller is speaking, not idle
      } else {
        this.silentGapMs += this.lastSpeechChunkAt > 0
          ? Math.min(now - this.lastSpeechChunkAt, 30)
          : 20;
        this.lastSpeechChunkAt = now;
        if (this.silentGapMs > 600) {
          this.speechMsSinceLastOutput = 0;
        }
      }
    }

    // Convert slin16 buffer to base64, apply gain for Gemini
    const base64 = slin16ToGeminiPcm(audioBuffer.toString("base64"));

    // Forward to Gemini
    this.gemini.sendAudio(base64, "audio/pcm;rate=16000");
  }

  // ─── Gemini -> Bridge Handlers ─────────────────────────────────────

  handleGeminiReady() {
    this.log.info("Gemini session ready");

    // If this is the first connection, send greeting
    if (!this.hasSentGreeting) {
      this.hasSentGreeting = true;
      this.beginProtectedAssistantTurn("greeting_prompt");

      const greetingInstruction = buildGreetingInstruction(
        this.cfg.tenant.name,
        this.cfg.contactName
      );
      this.gemini.sendText(greetingInstruction);
    }
  }

  handleGeminiAudio(audioBase64, mimeType) {
    this.postToolOutputGateUntil = 0;
    this.beginProtectedAssistantTurn("assistant_audio");
    this.geminiSpeaking = true;
    this.outboundAudioChunkCount += 1;
    this.audioChunksSentInCurrentTurn += 1;
    this.speechMsSinceLastOutput = 0;
    this.silentGapMs = 0;
    this.lastSpeechChunkAt = 0;

    // Store for recording
    this.recordingChunks.push(Buffer.from(audioBase64, "base64"));

    // Downsample Gemini PCM16 24kHz → 16kHz for Asterisk slin16
    const downsampledBase64 = downsample24kTo16k(audioBase64);

    // Send via callback set by media-bridge
    if (this.sendToAsterisk) {
      this.sendToAsterisk(downsampledBase64);
    }
  }

  handleInputTranscription(text) {
    const lastPart = this.conversationTranscriptParts[this.conversationTranscriptParts.length - 1];
    if (lastPart?.role === "user") {
      lastPart.text += text;
    } else {
      this.conversationTranscriptParts.push({ role: "user", text });
    }
  }

  handleOutputTranscription(text) {
    this.currentTurnTranscript += text;
    const lastPart = this.conversationTranscriptParts[this.conversationTranscriptParts.length - 1];
    if (lastPart?.role === "model") {
      lastPart.text += text;
    } else {
      this.conversationTranscriptParts.push({ role: "model", text });
    }
  }

  handleTurnComplete() {
    this.geminiSpeaking = false;

    // Hallucination detection — check if Gemini spoke about prices without a tool call
    // Only for non-greeting turns, and only once per call
    if (
      !this.correctionCheckedThisTurn &&
      this.currentTurnTranscript.length > 0 &&
      this.lastToolCallCompletedAtTurn === 0 &&
      this.protectedAssistantTurnCount > 1 &&
      this.correctionInjectionsUsed === 0
    ) {
      this.correctionCheckedThisTurn = true;
      const priceKeywords = ["\u05D3\u05D5\u05DC\u05E8", "\u05E9\u05E7\u05DC", "\u05D9\u05D5\u05E8\u05D5", "\u05DE\u05D7\u05D9\u05E8", "\u05DC\u05D0\u05D3\u05DD", "\u20AA", "$"];
      const hasPrice = priceKeywords.some((kw) => this.currentTurnTranscript.includes(kw));

      if (hasPrice) {
        this.correctionInjectionsUsed += 1;
        this.log.warn(
          { transcriptSnippet: this.currentTurnTranscript.slice(0, 200) },
          "Hallucination correction — agent mentioned prices without tool call"
        );
        this.gemini.sendText(buildHallucinationCorrectionInstruction());
      }
    }

    this.endProtectedAssistantTurn("turn_complete");
    this.lastTurnCompleteAt = Date.now();
    this.audioChunksSentInCurrentTurn = 0;
    this.speechMsSinceLastOutput = 0;
    this.silentGapMs = 0;
    this.lastSpeechChunkAt = 0;
    this.idleNudgeSent = false;
    this.currentTurnTranscript = "";
    this.correctionCheckedThisTurn = false;

    this.log.info(
      { inbound: this.inboundAudioChunkCount, outbound: this.outboundAudioChunkCount },
      "Gemini turn complete"
    );
  }

  handleGenerationComplete() {
    this.geminiSpeaking = false;
    // End half-duplex on generation complete for reply turns (not greeting)
    if (this.protectedAssistantTurnActive && this.protectedAssistantTurnCount > 1) {
      this.endProtectedAssistantTurn("generation_complete");
    }
  }

  handleInterrupted() {
    this.geminiSpeaking = false;
    this.endProtectedAssistantTurn("generation_interrupted");
  }

  async handleToolCalls(calls) {
    this.toolCallActive = true;
    this.suppressCallerAudioUntil = Date.now() + 30000; // Suppress during tool execution

    const responses = [];

    for (const call of calls) {
      this.log.info({ toolName: call.name }, "Executing tool call");

      const result = await executeToolCall(
        call.name,
        call.args,
        this.cfg.toolContext
      );

      responses.push({
        name: call.name,
        id: call.id,
        response: result,
      });

      // Check if end_call was invoked
      if (call.name === "end_call" && result.call_ended) {
        this.toolCallEndCall = true;
      }
    }

    // Send tool responses back to Gemini
    const payloadObj = { toolResponse: { functionResponses: responses } };
    this.lastToolResponsePayload = payloadObj;
    this.gemini.sendToolResponse(responses);

    this.toolCallActive = false;
    this.speechMsSinceLastOutput = 0;
    this.silentGapMs = 0;
    this.lastSpeechChunkAt = 0;
    this.lastToolCallCompletedAtTurn = this.protectedAssistantTurnCount;

    const now = Date.now();
    this.suppressCallerAudioUntil = now + TOOL_RESPONSE_SUPPRESS_MS;
    this.postToolOutputGateUntil = now + POST_TOOL_AUDIO_GATE_MAX_MS;

    // If end_call was called, allow the farewell to play then end
    if (this.toolCallEndCall) {
      setTimeout(() => {
        this.endBridge("tool_end_call");
      }, 8000); // Allow 8s for farewell audio
    }
  }

  handleGeminiError(error) {
    this.log.error({ error }, "Gemini session error");
    if (this.protectedAssistantTurnActive) {
      this.endProtectedAssistantTurn("gemini_error");
    }
  }

  handleGeminiClose(code, reason) {
    if (this.protectedAssistantTurnActive) {
      this.endProtectedAssistantTurn("gemini_ws_closed");
    }

    const isAbnormal = code !== 1000 && this.gemini.isReady;
    if (isAbnormal && this.geminiReconnectCount < MAX_GEMINI_RECONNECTS) {
      this.log.warn(
        { code, reason, attempt: this.geminiReconnectCount + 1 },
        "Gemini closed abnormally, attempting reconnect"
      );
      this.attemptReconnect();
    } else if (isAbnormal) {
      this.log.error({ code, reason }, "Gemini closed, max reconnects exceeded");
      this.endBridge("gemini_max_reconnects");
    }
  }

  // ─── Half-Duplex Gating (from FC) ────────────────────────────────

  beginProtectedAssistantTurn(reason) {
    if (this.protectedAssistantTurnActive) return;
    this.protectedAssistantTurnActive = true;
    this.suppressCallerAudioUntil = 0;
    this.protectedAssistantTurnCount += 1;
    this.currentTurnTranscript = "";
    this.correctionCheckedThisTurn = false;
  }

  endProtectedAssistantTurn(reason) {
    if (!this.protectedAssistantTurnActive) return;
    this.protectedAssistantTurnActive = false;
    const playbackTailMs =
      reason === "generation_complete" && this.protectedAssistantTurnCount > 1
        ? POST_GENERATION_PLAYBACK_TAIL_MS
        : HALF_DUPLEX_RELEASE_MS;
    this.suppressCallerAudioUntil = Date.now() + playbackTailMs;
  }

  // ─── Watchdog (two-tiered, from FC) ──────────────────────────────

  startWatchdog() {
    this.watchdogTimer = setInterval(() => {
      if (!this.gemini.isReady || !this.gemini.isOpen) return;
      if (this.reconnectInProgress) return;
      if (this.protectedAssistantTurnActive || this.toolCallActive) return;

      // Track 1: Bug Catcher — active speech, no Gemini response
      const speechSeconds = this.speechMsSinceLastOutput / 1000;
      if (speechSeconds >= WATCHDOG_SPEECH_DEAF_SEC) {
        this.log.warn(
          { speechSeconds: Math.round(speechSeconds) },
          "Watchdog Track 1: caller speaking but Gemini deaf, reconnecting"
        );
        this.attemptReconnect();
        return;
      }

      // Track 2: Idle Nudge — silence after turnComplete
      if (
        this.lastTurnCompleteAt > 0 &&
        !this.idleNudgeSent &&
        this.idleNudgeCount < MAX_IDLE_NUDGES &&
        !this.geminiSpeaking
      ) {
        const idleSec = (Date.now() - this.lastTurnCompleteAt) / 1000;
        if (idleSec >= WATCHDOG_IDLE_NUDGE_SEC) {
          this.idleNudgeSent = true;
          this.idleNudgeCount += 1;
          this.log.info(
            { idleSec: Math.round(idleSec), idleNudgeCount: this.idleNudgeCount },
            "Watchdog Track 2: idle nudge"
          );
          this.gemini.sendText(buildIdleNudgeInstruction());
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  // ─── Reconnect (from FC) ─────────────────────────────────────────

  attemptReconnect() {
    if (this.reconnectInProgress) return;

    this.geminiReconnectCount += 1;
    if (this.geminiReconnectCount > MAX_GEMINI_RECONNECTS) {
      this.log.error("Max Gemini reconnects exceeded, ending bridge");
      this.endBridge("gemini_max_reconnects");
      return;
    }

    this.reconnectInProgress = true;
    this.geminiSpeaking = false;
    this.protectedAssistantTurnActive = false;
    this.suppressCallerAudioUntil = Date.now() + 30000;
    this.postToolOutputGateUntil = 0;
    this.toolCallActive = false;
    this.currentTurnTranscript = "";
    this.correctionCheckedThisTurn = false;
    this.correctionInjectionsUsed = 0;
    this.lastToolCallCompletedAtTurn = 0;
    this.audioChunksSentInCurrentTurn = 0;
    this.speechMsSinceLastOutput = 0;
    this.silentGapMs = 0;
    this.lastSpeechChunkAt = 0;
    this.lastTurnCompleteAt = 0;
    this.idleNudgeSent = false;

    const reconnectInstruction = buildReconnectInstruction(
      this.cfg.tenant.name,
      this.cfg.contactName
    );

    this.gemini.reconnect(
      this.conversationTranscriptParts,
      this.lastToolResponsePayload,
      reconnectInstruction
    );

    this.reconnectInProgress = false;
  }

  // ─── Bridge Lifecycle ─────────────────────────────────────────────

  endBridge(reason) {
    if (!this.callEndedResolve) return; // Already ended

    this.endReason = reason;
    this.log.info(
      {
        reason,
        durationMs: Date.now() - this.callStartedAt,
        inbound: this.inboundAudioChunkCount,
        outbound: this.outboundAudioChunkCount,
        reconnects: this.geminiReconnectCount,
        transcriptParts: this.conversationTranscriptParts.length,
      },
      "Call bridge ending"
    );

    // Cleanup
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.hardTimeoutTimer) clearTimeout(this.hardTimeoutTimer);
    this.gemini.close();
    activeBridges.delete(this.cfg.callId);

    // Build recording buffer
    const recordingBuffer = this.recordingChunks.length > 0
      ? Buffer.concat(this.recordingChunks)
      : null;

    const result = {
      duration_seconds: Math.round((Date.now() - this.callStartedAt) / 1000),
      transcript: this.conversationTranscriptParts,
      recordingBuffer,
      endReason: reason,
      toolCallEndCall: this.toolCallEndCall,
    };

    const resolve = this.callEndedResolve;
    this.callEndedResolve = null;
    resolve(result);
  }

  /**
   * External cleanup entry point — called by media-bridge on Asterisk disconnect.
   */
  cleanup() {
    this.endBridge("asterisk_disconnect");
  }
}
