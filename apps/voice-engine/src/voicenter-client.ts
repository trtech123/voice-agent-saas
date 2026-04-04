// apps/voice-engine/src/voicenter-client.ts

/**
 * Voicenter API client for outbound call initiation and media streaming.
 *
 * Manages:
 * - Outbound call initiation via Voicenter REST API
 * - Media stream WebSocket connection for real-time audio
 * - Call status tracking and cleanup
 *
 * NOTE: Voicenter API contract is based on expected interface.
 * Adjust endpoints/payloads once Voicenter documentation is confirmed.
 */

import WebSocket from "ws";
import { config } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface VoicenterCredentials {
  apiKey: string;
  callerId: string;
  accountId: string;
  mediaStreamUrl?: string;
}

export interface OutboundCallResult {
  success: boolean;
  voicenterCallId: string | null;
  mediaStreamUrl: string | null;
  error?: string;
}

export interface VoicenterMediaStreamEvents {
  onAudio: (audioData: string, mimeType: string) => void;
  onCallConnected: (metadata: { from?: string; to?: string; streamId?: string }) => void;
  onCallEnded: (reason: string) => void;
  onError: (error: Error) => void;
}

// ─── Client ─────────────────────────────────────────────────────────

export class VoicenterClient {
  private baseUrl: string;
  private mediaWs: WebSocket | null = null;
  private callId: string | null = null;

  constructor(
    private credentials: VoicenterCredentials,
    private log: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    }
  ) {
    this.baseUrl = config.voicenterApiUrl;
  }

  /**
   * Initiate an outbound call via Voicenter REST API.
   * Returns the call ID and media stream URL for WebSocket connection.
   */
  async initiateCall(
    toPhone: string,
    internalCallId: string
  ): Promise<OutboundCallResult> {
    this.log.info(
      { to: redactPhone(toPhone), callerId: this.credentials.callerId },
      "Initiating outbound call via Voicenter"
    );

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/calls/outbound`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.credentials.apiKey}`,
          "X-Account-Id": this.credentials.accountId,
        },
        body: JSON.stringify({
          to: toPhone,
          from: this.credentials.callerId,
          callbackUrl: null, // We use WebSocket media stream instead of webhooks
          metadata: { internalCallId },
          mediaStream: {
            enabled: true,
            format: "pcm16", // 16-bit PCM, 16kHz mono
            sampleRate: 16000,
            channels: 1,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log.error(
          { status: response.status, error: errorText },
          "Voicenter outbound call failed"
        );
        return {
          success: false,
          voicenterCallId: null,
          mediaStreamUrl: null,
          error: `Voicenter API error: ${response.status} ${errorText}`,
        };
      }

      const data = (await response.json()) as {
        callId: string;
        mediaStreamUrl: string;
      };

      this.callId = data.callId;

      this.log.info(
        { voicenterCallId: data.callId },
        "Voicenter outbound call initiated"
      );

      return {
        success: true,
        voicenterCallId: data.callId,
        mediaStreamUrl: data.mediaStreamUrl,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, "Voicenter call initiation threw");
      return {
        success: false,
        voicenterCallId: null,
        mediaStreamUrl: null,
        error: message,
      };
    }
  }

  /**
   * Connect to the Voicenter media stream WebSocket.
   * Audio flows bidirectionally:
   * - Inbound: caller audio (PCM 16kHz) -> forwarded to Gemini
   * - Outbound: Gemini audio (PCM 24kHz) -> sent to caller
   */
  connectMediaStream(
    mediaStreamUrl: string,
    events: VoicenterMediaStreamEvents
  ): WebSocket {
    this.log.info({ url: redactUrl(mediaStreamUrl) }, "Connecting to Voicenter media stream");

    const ws = new WebSocket(mediaStreamUrl);
    this.mediaWs = ws;

    ws.on("open", () => {
      this.log.info("Voicenter media stream connected");
    });

    ws.on("message", (data) => {
      try {
        const payload = JSON.parse(data.toString());

        if (payload.event === "start") {
          events.onCallConnected({
            from: payload.from,
            to: payload.to,
            streamId: payload.streamId,
          });
          return;
        }

        if (payload.event === "media" && payload.audio?.data) {
          events.onAudio(
            payload.audio.data,
            payload.audio.mimeType || "audio/pcm;rate=16000"
          );
          return;
        }

        if (payload.event === "stop") {
          events.onCallEnded(payload.reason || "call_ended");
          return;
        }
      } catch (err) {
        this.log.error({ err }, "Error parsing Voicenter media stream message");
      }
    });

    ws.on("error", (error) => {
      this.log.error({ error }, "Voicenter media stream error");
      events.onError(error);
    });

    ws.on("close", (code, reason) => {
      const reasonStr = Buffer.isBuffer(reason) ? reason.toString() : String(reason);
      this.log.info(
        { code, reason: reasonStr },
        "Voicenter media stream closed"
      );
      if (code !== 1000) {
        events.onCallEnded(`media_stream_closed_${code}`);
      }
    });

    return ws;
  }

  /**
   * Send audio data to the caller via the media stream WebSocket.
   */
  sendAudio(audioBase64: string, mimeType: string): void {
    if (!this.mediaWs || this.mediaWs.readyState !== WebSocket.OPEN) {
      return;
    }
    this.mediaWs.send(
      JSON.stringify({
        event: "media",
        audio: {
          data: audioBase64,
          mimeType,
        },
      })
    );
  }

  /**
   * Hang up the call via Voicenter API.
   */
  async hangup(): Promise<void> {
    if (!this.callId) return;

    try {
      await fetch(`${this.baseUrl}/api/v1/calls/${this.callId}/hangup`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credentials.apiKey}`,
          "X-Account-Id": this.credentials.accountId,
        },
      });
      this.log.info({ voicenterCallId: this.callId }, "Voicenter call hung up");
    } catch (err) {
      this.log.error({ err, voicenterCallId: this.callId }, "Failed to hang up Voicenter call");
    }
  }

  /**
   * Clean up all connections.
   */
  cleanup(): void {
    if (this.mediaWs && this.mediaWs.readyState === WebSocket.OPEN) {
      this.mediaWs.close();
    }
    this.mediaWs = null;
    this.callId = null;
  }
}

// ─── Credential Helper ──────────────────────────────────────────────

/**
 * Parse decrypted Voicenter credentials from the tenant's encrypted column.
 */
export function parseVoicenterCredentials(decryptedJson: string): VoicenterCredentials {
  const parsed = JSON.parse(decryptedJson);
  if (!parsed.apiKey || !parsed.callerId || !parsed.accountId) {
    throw new Error("Invalid Voicenter credentials: missing apiKey, callerId, or accountId");
  }
  return {
    apiKey: parsed.apiKey,
    callerId: parsed.callerId,
    accountId: parsed.accountId,
    mediaStreamUrl: parsed.mediaStreamUrl,
  };
}

// ─── Utilities ──────────────────────────────────────────────────────

function redactPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "[redacted]";
  return `***${digits.slice(-4)}`;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/***`;
  } catch {
    return "[invalid-url]";
  }
}
