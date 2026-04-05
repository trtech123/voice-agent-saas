// apps/voice-engine/src/gemini-session.ts

/**
 * Gemini Live WebSocket session manager.
 *
 * Handles:
 * - WebSocket connection to Gemini Live API
 * - Setup payload construction (model, voice, system prompt, tools)
 * - NO_INTERRUPTION mode configuration
 * - Reconnection with conversation history replay
 *
 * Adapted from flyingcarpet/voice-agent/call-bridge.js buildGeminiSetupPayload()
 * and reconnectGemini() — made multi-tenant with dynamic prompts.
 */

import WebSocket from "ws";
import { config } from "./config.js";
import { buildToolDefinitions } from "./tools.js";

// ─── Constants ──────────────────────────────────────────────────────

const GEMINI_WS_URL =
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.` +
  `GenerativeService.BidiGenerateContent?key=${config.geminiApiKey}`;

/** Maximum number of Gemini session reconnects per call before giving up. */
export const MAX_GEMINI_RECONNECTS = 2;

/** Whether to include tools in Gemini setup (can be toggled to work around Live API bugs). */
const GEMINI_LIVE_INCLUDE_TOOLS = !/^0|false|no|off$/i.test(
  String(process.env.GEMINI_LIVE_INCLUDE_TOOLS ?? "true").trim()
);

// ─── Types ──────────────────────────────────────────────────────────

export interface GeminiSessionConfig {
  systemPrompt: string;
  voiceName?: string;
}

export interface TranscriptPart {
  role: "user" | "model";
  text: string;
}

export interface GeminiSessionEvents {
  onSetupComplete: () => void;
  onAudio: (audioBase64: string, mimeType: string) => void;
  onInputTranscription: (text: string) => void;
  onOutputTranscription: (text: string) => void;
  onTurnComplete: () => void;
  onGenerationComplete: () => void;
  onInterrupted: () => void;
  onToolCall: (functionCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }>) => void;
  onError: (error: Error) => void;
  onClose: (code: number, reason: string) => void;
}

// ─── Session Manager ────────────────────────────────────────────────

export class GeminiSession {
  private ws: WebSocket | null = null;
  private sessionConfig: GeminiSessionConfig;
  private events: GeminiSessionEvents;
  private log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  private _isReady = false;

  constructor(
    sessionConfig: GeminiSessionConfig,
    events: GeminiSessionEvents,
    log: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    }
  ) {
    this.sessionConfig = sessionConfig;
    this.events = events;
    this.log = log;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  /**
   * Build the Gemini Live setup payload with dynamic system prompt and tools.
   */
  private buildSetupPayload(): Record<string, unknown> {
    return {
      setup: {
        model: config.geminiModel,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.sessionConfig.voiceName || process.env.GEMINI_VOICE_NAME || "Aoede",
              },
            },
          },
        },
        realtimeInputConfig: {
          activityHandling: "NO_INTERRUPTION",
          automaticActivityDetection: {
            startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [{ text: this.sessionConfig.systemPrompt }],
        },
        ...(GEMINI_LIVE_INCLUDE_TOOLS
          ? { tools: [buildToolDefinitions()] }
          : {}),
      },
    };
  }

  /**
   * Open a new Gemini Live WebSocket connection.
   */
  connect(): void {
    this._isReady = false;
    const ws = new WebSocket(GEMINI_WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      this.log.info(
        {
          model: config.geminiModel,
          toolsEnabled: GEMINI_LIVE_INCLUDE_TOOLS,
        },
        "Sending Gemini Live setup"
      );
      ws.send(JSON.stringify(this.buildSetupPayload()));
    });

    ws.on("message", (data) => this.handleMessage(data));

    ws.on("error", (error) => {
      this.log.error({ error }, "Gemini WebSocket error");
      this.events.onError(error);
    });

    ws.on("close", (code, reasonBuffer) => {
      this._isReady = false;
      const reason =
        Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0
          ? reasonBuffer.toString()
          : "";
      this.log.info({ code, reason }, "Gemini WebSocket closed");
      this.events.onClose(code, reason);
    });
  }

  /**
   * Tear down current session and open a fresh one for reconnection.
   * Preserves conversation history via clientContent injection.
   */
  reconnect(
    conversationHistory: TranscriptPart[],
    lastToolResponsePayload: Record<string, unknown> | null,
    reconnectInstruction: string
  ): void {
    this._isReady = false;

    // Close old WebSocket
    const oldWs = this.ws;
    if (oldWs) {
      oldWs.removeAllListeners();
      oldWs.on("close", () => {
        this.log.info("Old Gemini WebSocket closed after reconnect");
      });
      if (
        oldWs.readyState === WebSocket.OPEN ||
        oldWs.readyState === WebSocket.CONNECTING
      ) {
        oldWs.close();
      }
    }

    // Open fresh connection
    const ws = new WebSocket(GEMINI_WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      this.log.info("Reconnect: sending Gemini setup");
      ws.send(JSON.stringify(this.buildSetupPayload()));
    });

    // Override message handler to inject history on setupComplete
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.setupComplete) {
        this._isReady = true;
        this.log.info(
          { transcriptParts: conversationHistory.length },
          "Reconnect: Gemini session ready, injecting conversation context"
        );

        // Seed conversation history via clientContent
        if (conversationHistory.length > 0) {
          const turns = conversationHistory.map((p) => ({
            role: p.role,
            parts: [{ text: p.text.trim() }],
          }));
          ws.send(JSON.stringify({
            clientContent: { turns, turnComplete: true },
          }));

          // Inject last tool response as context if present
          if (lastToolResponsePayload) {
            const toolResults = (
              lastToolResponsePayload as {
                toolResponse: {
                  functionResponses: Array<{ name: string; response: unknown }>;
                };
              }
            ).toolResponse.functionResponses
              .map((r) => `[Tool: ${r.name}] ${JSON.stringify(r.response)}`)
              .join("\n");
            ws.send(JSON.stringify({
              realtimeInput: {
                text: `[נתוני כלים מהשיחה הקודמת - השתמש/י בהם אם הלקוח שאל על תוצאות]\n${toolResults}`,
              },
            }));
          }

          // Behavioral nudge to resume conversation
          ws.send(JSON.stringify({
            realtimeInput: { text: reconnectInstruction },
          }));
        } else {
          // No transcript — fresh greeting
          ws.send(JSON.stringify({
            realtimeInput: { text: reconnectInstruction },
          }));
        }

        this.events.onSetupComplete();

        // Now switch to normal message handling
        ws.removeAllListeners("message");
        ws.on("message", (d) => this.handleMessage(d));
        return;
      }

      // For any other messages before setupComplete, use normal handler
      this.handleMessage(data);
    });

    ws.on("error", (error) => {
      this.log.error({ error }, "Gemini reconnect WebSocket error");
      this.events.onError(error);
    });

    ws.on("close", (code, reasonBuffer) => {
      this._isReady = false;
      const reason =
        Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0
          ? reasonBuffer.toString()
          : "";
      this.events.onClose(code, reason);
    });
  }

  /**
   * Send caller audio to Gemini.
   */
  sendAudio(audioBase64: string, mimeType = "audio/pcm;rate=16000"): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this._isReady) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: audioBase64, mimeType },
        },
      })
    );
  }

  /**
   * Send a text instruction to Gemini (realtimeInput.text).
   */
  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ realtimeInput: { text } }));
  }

  /**
   * Send tool response back to Gemini after executing a function call.
   */
  sendToolResponse(
    responses: Array<{ name: string; id?: string; response: Record<string, unknown> }>
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        toolResponse: { functionResponses: responses },
      })
    );
  }

  /**
   * Close the Gemini WebSocket connection.
   */
  close(): void {
    this._isReady = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  // ─── Internal Message Handler ───────────────────────────────────

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.setupComplete) {
        this._isReady = true;
        this.events.onSetupComplete();
        return;
      }

      if (msg.serverContent?.interrupted) {
        this.events.onInterrupted();
      }

      if (msg.serverContent?.generationComplete) {
        this.events.onGenerationComplete();
      }

      if (msg.serverContent?.turnComplete) {
        this.events.onTurnComplete();
      }

      if (msg.serverContent?.outputTranscription?.text) {
        this.events.onOutputTranscription(msg.serverContent.outputTranscription.text);
      }

      if (msg.serverContent?.inputTranscription?.text) {
        this.events.onInputTranscription(msg.serverContent.inputTranscription.text);
      }

      if (msg.serverContent?.modelTurn?.parts) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            this.events.onAudio(
              part.inlineData.data,
              part.inlineData.mimeType || "audio/pcm;rate=24000"
            );
          }
        }
      }

      if (msg.toolCall?.functionCalls) {
        this.events.onToolCall(
          msg.toolCall.functionCalls.map(
            (fc: { id?: string; name: string; args?: Record<string, unknown> }) => ({
              id: fc.id,
              name: fc.name,
              args: fc.args ?? {},
            })
          )
        );
      }
    } catch (err) {
      this.log.error({ err }, "Error parsing Gemini message");
    }
  }
}
