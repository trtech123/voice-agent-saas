// apps/voice-engine/src/voicenter-client.ts

/**
 * Asterisk SIP Gateway client for outbound call initiation and media streaming.
 *
 * Replaces the previous direct Voicenter REST API integration. Calls are now
 * routed through the Asterisk gateway running on the DigitalOcean droplet
 * (POST /calls), which handles SIP signaling via Voicenter's PJSIP trunk.
 *
 * Media streams flow over WebSocket between the voice engine (Railway) and
 * the gateway, which bridges audio into/out of the Asterisk channel.
 *
 * Lifecycle events (dialing, ringing, connected, ended, etc.) are pushed
 * from the gateway to the voice engine via the eventWebhookUrl callback.
 */

import WebSocket from "ws";
import { config } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface SipGatewayCredentials {
  apiKey: string;
  callerId: string;
  tenantId: string;
}

export interface OutboundCallResult {
  success: boolean;
  sipCallId: string | null;
  mediaStreamUrl: string | null;
  error?: string;
}

export interface SipGatewayMediaStreamEvents {
  onAudio: (audioData: string, mimeType: string) => void;
  onCallConnected: (metadata: { from?: string; to?: string; streamId?: string }) => void;
  onCallEnded: (reason: string) => void;
  onError: (error: Error) => void;
}

// ─── Client ─────────────────────────────────────────────────────────

export class VoicenterClient {
  private gatewayBaseUrl: string;
  private mediaWs: WebSocket | null = null;
  private sipCallId: string | null = null;

  constructor(
    private credentials: SipGatewayCredentials,
    private log: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    }
  ) {
    this.gatewayBaseUrl = config.sipGatewayBaseUrl.replace(/\/+$/, "");
  }

  /**
   * Initiate an outbound call via the Asterisk SIP gateway.
   *
   * The gateway creates an Asterisk bridge, dials the target number over
   * the Voicenter PJSIP trunk, and returns a sipCallId. The voice engine
   * should provide a mediaStreamUrl (WebSocket endpoint) where the gateway
   * will connect to relay bidirectional audio.
   */
  async initiateCall(
    toPhone: string,
    internalCallId: string,
    options: {
      eventWebhookUrl: string;
      mediaStreamUrl: string;
    }
  ): Promise<OutboundCallResult> {
    this.log.info(
      { to: redactPhone(toPhone), callerId: this.credentials.callerId },
      "Initiating outbound call via SIP gateway"
    );

    try {
      const response = await fetch(`${this.gatewayBaseUrl}/calls`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.sipGatewayApiKey}`,
        },
        body: JSON.stringify({
          callId: internalCallId,
          to: toPhone,
          eventWebhookUrl: options.eventWebhookUrl,
          mediaStreamUrl: options.mediaStreamUrl,
          tenantId: this.credentials.tenantId,
          metadata: {
            callerId: this.credentials.callerId,
            tenantId: this.credentials.tenantId,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log.error(
          { status: response.status, error: errorText },
          "SIP gateway outbound call failed"
        );
        return {
          success: false,
          sipCallId: null,
          mediaStreamUrl: null,
          error: `SIP gateway error: ${response.status} ${errorText}`,
        };
      }

      const data = (await response.json()) as {
        success: boolean;
        sipCallId: string;
        status: string;
        bridgeId: string;
        customerChannelId: string;
        mediaChannelId: string;
      };

      this.sipCallId = data.sipCallId;

      this.log.info(
        { sipCallId: data.sipCallId, status: data.status },
        "SIP gateway outbound call initiated"
      );

      return {
        success: true,
        sipCallId: data.sipCallId,
        mediaStreamUrl: options.mediaStreamUrl,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, "SIP gateway call initiation threw");
      return {
        success: false,
        sipCallId: null,
        mediaStreamUrl: null,
        error: message,
      };
    }
  }

  /**
   * Connect to the gateway's media stream WebSocket.
   *
   * In the Asterisk gateway architecture, media flows differently than the
   * old direct Voicenter API. The gateway connects *to us* (the voice engine
   * exposes a WebSocket), so this method is used when the voice engine needs
   * to connect to a media stream URL provided by the gateway.
   *
   * Audio flows bidirectionally:
   * - Inbound: caller audio from Asterisk -> forwarded to AI model
   * - Outbound: AI model audio -> sent to caller via Asterisk
   */
  connectMediaStream(
    mediaStreamUrl: string,
    events: SipGatewayMediaStreamEvents
  ): WebSocket {
    this.log.info({ url: redactUrl(mediaStreamUrl) }, "Connecting to SIP gateway media stream");

    const ws = new WebSocket(mediaStreamUrl);
    this.mediaWs = ws;

    ws.on("open", () => {
      this.log.info("SIP gateway media stream connected");
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
            payload.audio.mimeType || "audio/pcm;rate=8000;codec=ulaw"
          );
          return;
        }

        if (payload.event === "stop") {
          events.onCallEnded(payload.reason || "call_ended");
          return;
        }
      } catch (err) {
        this.log.error({ err }, "Error parsing SIP gateway media stream message");
      }
    });

    ws.on("error", (error) => {
      this.log.error({ error }, "SIP gateway media stream error");
      events.onError(error);
    });

    ws.on("close", (code, reason) => {
      const reasonStr = Buffer.isBuffer(reason) ? reason.toString() : String(reason);
      this.log.info(
        { code, reason: reasonStr },
        "SIP gateway media stream closed"
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
   * Hang up the call via the SIP gateway API.
   */
  async hangup(): Promise<void> {
    if (!this.sipCallId) return;

    try {
      await fetch(`${this.gatewayBaseUrl}/calls/${this.sipCallId}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.sipGatewayApiKey}`,
        },
        body: JSON.stringify({ reason: "voice_engine_hangup" }),
      });
      this.log.info({ sipCallId: this.sipCallId }, "SIP gateway call hung up");
    } catch (err) {
      this.log.error({ err, sipCallId: this.sipCallId }, "Failed to hang up SIP gateway call");
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
    this.sipCallId = null;
  }
}

// ─── Credential Helper ──────────────────────────────────────────────

/**
 * Parse SIP gateway credentials from the tenant's configuration.
 * The gateway uses a shared API key for authentication, while tenant-specific
 * fields (callerId, tenantId) are passed per-call.
 */
export function parseSipGatewayCredentials(tenantConfig: {
  callerId?: string;
  tenantId: string;
}): SipGatewayCredentials {
  if (!tenantConfig.tenantId) {
    throw new Error("Invalid SIP gateway credentials: missing tenantId");
  }
  return {
    apiKey: config.sipGatewayApiKey,
    callerId: tenantConfig.callerId || config.sipGatewayApiKey,
    tenantId: tenantConfig.tenantId,
  };
}

// Keep the old interface name exported for backward compatibility
export type VoicenterCredentials = SipGatewayCredentials;
export type VoicenterMediaStreamEvents = SipGatewayMediaStreamEvents;

/** @deprecated Use parseSipGatewayCredentials instead */
export function parseVoicenterCredentials(decryptedJson: string): SipGatewayCredentials {
  const parsed = JSON.parse(decryptedJson);
  return parseSipGatewayCredentials({
    callerId: parsed.callerId,
    tenantId: parsed.tenantId || parsed.accountId,
  });
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
