// apps/voice-engine/src/call-bridge.ts

/**
 * Call Bridge — Audio bridge between Voicenter telephony and Gemini Live AI.
 *
 * Adapted from flyingcarpet/voice-agent/call-bridge.js for multi-tenant SaaS.
 *
 * Carried over from FlyingCarpet:
 * - NO_INTERRUPTION mode (prevents Gemini deaf session bug)
 * - Two-tiered watchdog: Track 1 (deaf detection), Track 2 (idle nudge)
 * - Watchdog reconnect with conversation history replay (max 2 reconnects)
 * - Half-duplex audio management (suppress caller during agent speech)
 * - Server-side hallucination detection + correction injection (max 1 per call)
 * - VAD reset silence injection on gate lift
 *
 * New for SaaS:
 * - Dynamic system prompt from campaign config
 * - Multi-tenant tool execution context
 * - Recording consent disclosure
 * - Hard timeout (5 min max per call)
 * - Campaign-scoped concurrency (managed externally by BullMQ)
 */

import WebSocket from "ws";
import { GeminiSession, MAX_GEMINI_RECONNECTS, type TranscriptPart } from "./gemini-session.js";
import { VoicenterClient, type VoicenterMediaStreamEvents } from "./voicenter-client.js";
import { executeToolCall, type ToolExecutionContext, type ToolResult } from "./tools.js";
import { computeRmsBase64, createSilenceBuffer, SPEECH_RMS_THRESHOLD, ulawToGeminiPcm, geminiPcmToUlaw } from "./audio-utils.js";
import {
  buildSystemPrompt,
  buildGreetingInstruction,
  buildReconnectInstruction,
  buildIdleNudgeInstruction,
  buildHallucinationCorrectionInstruction,
} from "./agent-prompt.js";
import { config } from "./config.js";

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

// ─── Types ──────────────────────────────────────────────────────────

export interface CallBridgeConfig {
  callId: string;
  tenantId: string;
  campaignId: string;
  contactId: string;
  campaignContactId: string;
  contactPhone: string;
  contactName: string | null;
  campaign: {
    script: string;
    questions: Array<{ question: string; key: string; options?: string[] }>;
    whatsapp_followup_template: string | null;
    whatsapp_followup_link: string | null;
  };
  tenant: {
    name: string;
    business_type: string;
  };
  contact: {
    name: string | null;
    phone: string;
    custom_fields: Record<string, unknown>;
  };
  toolContext: ToolExecutionContext;
  voicenterClient: VoicenterClient;
  /** Optional callback to send control messages to the gateway WebSocket */
  onGatewayControl?: (message: Record<string, unknown>) => void;
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    child: (bindings: Record<string, unknown>) => CallBridgeConfig["log"];
  };
}

export interface CallBridgeResult {
  duration_seconds: number;
  transcript: TranscriptPart[];
  recordingBuffer: Buffer | null;
  endReason: string;
  toolCallEndCall: boolean;
}

// ─── Active Bridge Tracking ─────────────────────────────────────────

const activeBridges = new Map<string, CallBridge>();

export function getActiveBridgeCount(): number {
  return activeBridges.size;
}

export function getActiveBridge(callId: string): CallBridge | undefined {
  return activeBridges.get(callId);
}

// ─── Call Bridge Class ──────────────────────────────────────────────

export class CallBridge {
  private cfg: CallBridgeConfig;
  private gemini: GeminiSession;
  private log: CallBridgeConfig["log"];

  // Half-duplex state (from FC)
  private geminiSpeaking = false;
  private protectedAssistantTurnActive = false;
  private protectedAssistantTurnCount = 0;
  private suppressCallerAudioUntil = 0;
  private postToolOutputGateUntil = 0;
  private audioWasGated = false;

  // Audio counters
  private inboundAudioChunkCount = 0;
  private outboundAudioChunkCount = 0;
  private suppressedInboundChunkCount = 0;
  private audioChunksSentInCurrentTurn = 0;

  // Transcript
  private conversationTranscriptParts: TranscriptPart[] = [];
  private currentTurnTranscript = "";

  // Watchdog state (two-tiered, from FC)
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private speechMsSinceLastOutput = 0;
  private lastSpeechChunkAt = 0;
  private silentGapMs = 0;
  private lastTurnCompleteAt = 0;
  private idleNudgeSent = false;
  private idleNudgeCount = 0;

  // Reconnect state
  private geminiReconnectCount = 0;
  private reconnectInProgress = false;
  private lastToolResponsePayload: Record<string, unknown> | null = null;

  // Hallucination detection
  private correctionInjectionsUsed = 0;
  private correctionCheckedThisTurn = false;
  private lastToolCallCompletedAtTurn = 0;

  // Tool call state
  private toolCallActive = false;

  // Lifecycle
  private hasSentGreeting = false;
  private callStartedAt: number;
  private callEndedResolve: ((result: CallBridgeResult) => void) | null = null;
  private endReason = "unknown";
  private toolCallEndCall = false;
  private hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private recordingChunks: Buffer[] = [];
  private _mediaEvents: VoicenterMediaStreamEvents | null = null;

  constructor(cfg: CallBridgeConfig) {
    this.cfg = cfg;
    this.log = cfg.log.child({ component: "call-bridge", callId: cfg.callId });
    this.callStartedAt = Date.now();

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
   * The bridge wires Voicenter media stream to Gemini Live session.
   */
  async start(): Promise<CallBridgeResult> {
    activeBridges.set(this.cfg.callId, this);

    return new Promise<CallBridgeResult>((resolve) => {
      this.callEndedResolve = resolve;

      // Hard timeout — 5 minutes max per call
      this.hardTimeoutTimer = setTimeout(() => {
        this.log.warn("Hard timeout reached (5 min), forcing call cleanup");
        this.endBridge("hard_timeout");
      }, config.callHardTimeoutMs);

      // Start Gemini session
      this.gemini.connect();

      // Connect Voicenter media stream events to bridge
      const mediaEvents: VoicenterMediaStreamEvents = {
        onAudio: (audioData, mimeType) => this.handleCallerAudio(audioData, mimeType),
        onCallConnected: (meta) => this.handleCallConnected(meta),
        onCallEnded: (reason) => this.endBridge(`voicenter_${reason}`),
        onError: (error) => {
          this.log.error({ error }, "Voicenter media stream error in bridge");
          this.endBridge("voicenter_error");
        },
      };

      // Store the event handlers for external wiring
      this._mediaEvents = mediaEvents;

      // Start watchdog
      this.startWatchdog();
    });
  }

  /**
   * Get the media stream event handlers for external Voicenter wiring.
   */
  getMediaEvents(): VoicenterMediaStreamEvents {
    return this._mediaEvents!;
  }

  // ─── Voicenter -> Bridge Handlers ─────────────────────────────────

  private handleCallConnected(meta: { from?: string; to?: string; streamId?: string }): void {
    this.log.info({ meta }, "Call connected, telephony ready");
  }

  private handleCallerAudio(audioBase64: string, _mimeType: string): void {
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

    // Transcode ulaw 8kHz → PCM16 16kHz for Gemini
    const pcmBase64 = ulawToGeminiPcm(audioBase64);

    // RMS-based speech detection for watchdog (use PCM version for accuracy)
    const rms = computeRmsBase64(pcmBase64);
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

    // Forward transcoded audio to Gemini
    this.gemini.sendAudio(pcmBase64, "audio/pcm;rate=16000");
  }

  // ─── Gemini -> Bridge Handlers ─────────────────────────────────────

  private handleGeminiReady(): void {
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

  private handleGeminiAudio(audioBase64: string, mimeType: string): void {
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

    // Transcode Gemini PCM16 24kHz → ulaw 8kHz for Asterisk
    const ulawBase64 = geminiPcmToUlaw(audioBase64);
    this.cfg.voicenterClient.sendAudio(ulawBase64, "audio/x-mulaw;rate=8000");
  }

  private handleInputTranscription(text: string): void {
    const lastPart = this.conversationTranscriptParts[this.conversationTranscriptParts.length - 1];
    if (lastPart?.role === "user") {
      lastPart.text += text;
    } else {
      this.conversationTranscriptParts.push({ role: "user", text });
    }
  }

  private handleOutputTranscription(text: string): void {
    this.currentTurnTranscript += text;
    const lastPart = this.conversationTranscriptParts[this.conversationTranscriptParts.length - 1];
    if (lastPart?.role === "model") {
      lastPart.text += text;
    } else {
      this.conversationTranscriptParts.push({ role: "model", text });
    }
  }

  private handleTurnComplete(): void {
    this.geminiSpeaking = false;

    // Hallucination detection — check if Gemini spoke without calling a tool
    // Only for non-greeting turns, and only once per call
    if (
      !this.correctionCheckedThisTurn &&
      this.currentTurnTranscript.length > 0 &&
      this.lastToolCallCompletedAtTurn === 0 &&
      this.protectedAssistantTurnCount > 1 &&
      this.correctionInjectionsUsed === 0
    ) {
      this.correctionCheckedThisTurn = true;
      // For SaaS, hallucination detection is simpler — check if the agent
      // mentioned specific numbers or prices without a tool call
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

  private handleGenerationComplete(): void {
    this.geminiSpeaking = false;
    // End half-duplex on generation complete for reply turns (not greeting)
    if (this.protectedAssistantTurnActive && this.protectedAssistantTurnCount > 1) {
      this.endProtectedAssistantTurn("generation_complete");
    }
  }

  private handleInterrupted(): void {
    this.geminiSpeaking = false;
    this.endProtectedAssistantTurn("generation_interrupted");
  }

  private async handleToolCalls(
    calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>
  ): Promise<void> {
    this.toolCallActive = true;
    this.suppressCallerAudioUntil = Date.now() + 30000; // Suppress during tool execution

    const responses: Array<{ name: string; id?: string; response: ToolResult }> = [];

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

  private handleGeminiError(error: Error): void {
    this.log.error({ error }, "Gemini session error");
    if (this.protectedAssistantTurnActive) {
      this.endProtectedAssistantTurn("gemini_error");
    }
  }

  private handleGeminiClose(code: number, reason: string): void {
    if (this.protectedAssistantTurnActive) {
      this.endProtectedAssistantTurn("gemini_ws_closed");
    }

    // Notify gateway that Gemini disconnected so it can clear its gate
    this.cfg.onGatewayControl?.({
      event: "gemini_disconnected",
      code,
      reason,
    });

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

  private beginProtectedAssistantTurn(_reason: string): void {
    if (this.protectedAssistantTurnActive) return;
    this.protectedAssistantTurnActive = true;
    this.suppressCallerAudioUntil = 0;
    this.protectedAssistantTurnCount += 1;
    this.currentTurnTranscript = "";
    this.correctionCheckedThisTurn = false;

    // Notify gateway to activate its own half-duplex gate
    this.cfg.onGatewayControl?.({
      event: "assistant_turn_state",
      protected: true,
      phase: _reason,
      turnIndex: this.protectedAssistantTurnCount,
    });
  }

  private endProtectedAssistantTurn(reason: string): void {
    if (!this.protectedAssistantTurnActive) return;
    this.protectedAssistantTurnActive = false;
    const playbackTailMs =
      reason === "generation_complete" && this.protectedAssistantTurnCount > 1
        ? POST_GENERATION_PLAYBACK_TAIL_MS
        : HALF_DUPLEX_RELEASE_MS;
    this.suppressCallerAudioUntil = Date.now() + playbackTailMs;

    // Notify gateway to release its own half-duplex gate
    this.cfg.onGatewayControl?.({
      event: "assistant_turn_state",
      protected: false,
      phase: reason,
      turnIndex: this.protectedAssistantTurnCount,
    });
  }

  // ─── Watchdog (two-tiered, from FC) ──────────────────────────────

  private startWatchdog(): void {
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

  private attemptReconnect(): void {
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

    // The reconnect sets up its own setupComplete handler that will call
    // handleGeminiReady -> beginProtectedAssistantTurn, which lifts
    // reconnectInProgress via the flow.
    this.reconnectInProgress = false;
  }

  // ─── Bridge Lifecycle ─────────────────────────────────────────────

  private endBridge(reason: string): void {
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

    const result: CallBridgeResult = {
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
}
