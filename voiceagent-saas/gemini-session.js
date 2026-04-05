// voiceagent-saas/gemini-session.js

/**
 * Gemini Live WebSocket session manager.
 *
 * Handles:
 * - WebSocket connection to Gemini Live API
 * - Setup payload construction (model, voice, system prompt, tools)
 * - NO_INTERRUPTION mode configuration
 * - Reconnection with conversation history replay
 *
 * Ported from apps/voice-engine/src/gemini-session.ts
 * Changes: TypeScript removed, default voice → Kore, default model → gemini-3.1-flash-live-preview,
 * config imports replaced with process.env references.
 */

import WebSocket from "ws";
import { GoogleAuth } from "google-auth-library";
import { buildToolDefinitions } from "./tools.js";

// ─── Constants ──────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_LOCATION = process.env.GCP_LOCATION || "europe-west1";
const USE_VERTEX_AI = process.env.USE_VERTEX_AI === "true";

// Vertex AI EU endpoint (low latency for EU-based servers)
const VERTEX_AI_WS_URL =
  `wss://${GCP_LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;

// Google AI Studio endpoint (fallback)
const AI_STUDIO_WS_URL =
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.` +
  `GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const GEMINI_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";

// Google Auth client for Vertex AI OAuth tokens
let authClient = null;
if (USE_VERTEX_AI && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  authClient = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
}

async function getGeminiWsUrl() {
  if (!USE_VERTEX_AI) {
    return AI_STUDIO_WS_URL;
  }
  // Get OAuth token for Vertex AI
  const client = await authClient.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse.token;
  // Vertex AI: model goes in setup payload, token in URL query
  return `${VERTEX_AI_WS_URL}?access_token=${token}`;
}

/** Build the full model resource name for Vertex AI setup payload */
function getModelForSetup() {
  if (USE_VERTEX_AI) {
    return `projects/${GCP_PROJECT_ID}/locations/${GCP_LOCATION}/publishers/google/models/${GEMINI_MODEL}`;
  }
  // Google AI Studio uses simple model names with "models/" prefix
  return GEMINI_MODEL.startsWith("models/") ? GEMINI_MODEL : `models/${GEMINI_MODEL}`;
}

/** Maximum number of Gemini session reconnects per call before giving up. */
export const MAX_GEMINI_RECONNECTS = 2;

/** Whether to include tools in Gemini setup (can be toggled to work around Live API bugs). */
const GEMINI_LIVE_INCLUDE_TOOLS = !/^0|false|no|off$/i.test(
  String(process.env.GEMINI_LIVE_INCLUDE_TOOLS ?? "true").trim()
);

// ─── Session Manager ────────────────────────────────────────────────

export class GeminiSession {
  constructor(sessionConfig, events, log) {
    this.ws = null;
    this.sessionConfig = sessionConfig;
    this.events = events;
    this.log = log;
    this._isReady = false;
  }

  get isReady() {
    return this._isReady;
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get readyState() {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  /**
   * Build the Gemini Live setup payload with dynamic system prompt and tools.
   */
  buildSetupPayload() {
    return {
      setup: {
        model: getModelForSetup(),
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.sessionConfig.voiceName || process.env.GEMINI_VOICE_NAME || "Kore",
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
  async connect() {
    this._isReady = false;
    const wsUrl = await getGeminiWsUrl();
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.log.info(
        {
          model: getModelForSetup(),
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
  async reconnect(conversationHistory, lastToolResponsePayload, reconnectInstruction) {
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

    // Open fresh connection (with fresh OAuth token for Vertex AI)
    const wsUrl = await getGeminiWsUrl();
    const ws = new WebSocket(wsUrl);
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
            const toolResults = lastToolResponsePayload.toolResponse.functionResponses
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
  sendAudio(audioBase64, mimeType = "audio/pcm;rate=16000") {
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
  sendText(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ realtimeInput: { text } }));
  }

  /**
   * Send tool response back to Gemini after executing a function call.
   */
  sendToolResponse(responses) {
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
  close() {
    this._isReady = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  // ─── Internal Message Handler ───────────────────────────────────

  handleMessage(data) {
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
          msg.toolCall.functionCalls.map((fc) => ({
            id: fc.id,
            name: fc.name,
            args: fc.args ?? {},
          }))
        );
      }
    } catch (err) {
      this.log.error({ err }, "Error parsing Gemini message");
    }
  }
}
