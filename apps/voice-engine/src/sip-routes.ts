// apps/voice-engine/src/sip-routes.ts

/**
 * SIP Gateway callback routes — receives lifecycle events and media streams
 * from the Asterisk gateway running on the DigitalOcean droplet.
 *
 * Two endpoints:
 *   POST /api/v1/sip-events  — lifecycle events (dialing, ringing, connected, ended, etc.)
 *   GET  /api/v1/media-stream — WebSocket for bidirectional audio relay
 *
 * The gateway connects *to us*:
 *   1. call-processor tells the gateway our callback URLs
 *   2. The gateway POSTs lifecycle events as they happen
 *   3. The gateway opens a WebSocket to stream audio bidirectionally
 *
 * Audio flow: Gateway WS -> Voice Engine -> Gemini Live -> Voice Engine -> Gateway WS -> Asterisk -> Phone
 */

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { SipGatewayMediaStreamEvents } from "./voicenter-client.js";
import { config } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface SipLifecycleEvent {
  eventId: string;
  callId: string;
  sipCallId: string;
  phoneNumber?: string;
  tenantId?: string;
  event: string;
  reason?: string;
  streamId?: string;
  [key: string]: unknown;
}

export type PendingCallStatus =
  | "registered"
  | "dialing"
  | "ringing"
  | "connected"
  | "media_connected"
  | "ended"
  | "failed"
  | "bridge_failed";

export interface PendingCall {
  callId: string;
  sipCallId: string | null;
  status: PendingCallStatus;
  registeredAt: number;
  mediaEvents: SipGatewayMediaStreamEvents | null;
  gatewaySocket: WebSocket | null;
  lifecycleEvents: SipLifecycleEvent[];
  /** Resolves when the gateway WS connects and the "start" event fires */
  onMediaConnected: ((ws: WebSocket) => void) | null;
}

// ─── Pending Call Registry ──────────────────────────────────────────

const pendingCalls = new Map<string, PendingCall>();

/** TTL for stale pending calls — 2 minutes */
const PENDING_CALL_TTL_MS = 120_000;

/**
 * Register a call so the SIP routes can match incoming gateway connections.
 * Called by call-processor before initiating the gateway call.
 */
export function registerPendingCall(callId: string): PendingCall {
  const entry: PendingCall = {
    callId,
    sipCallId: null,
    status: "registered",
    registeredAt: Date.now(),
    mediaEvents: null,
    gatewaySocket: null,
    lifecycleEvents: [],
    onMediaConnected: null,
  };
  pendingCalls.set(callId, entry);
  return entry;
}

/**
 * Attach the bridge's media event handlers to a pending call.
 * Called after the CallBridge is created and start() has been invoked.
 */
export function attachMediaEvents(
  callId: string,
  events: SipGatewayMediaStreamEvents
): void {
  const entry = pendingCalls.get(callId);
  if (!entry) return;
  entry.mediaEvents = events;

  // If the gateway WebSocket already connected before the bridge was ready,
  // fire the start event now
  if (entry.gatewaySocket && entry.status === "media_connected") {
    events.onCallConnected({ streamId: callId });
  }
}

/**
 * Wait for the gateway to connect its media WebSocket.
 * Returns the WebSocket once connected, or null on timeout.
 */
export function waitForMediaConnection(
  callId: string,
  timeoutMs = 30_000
): Promise<WebSocket | null> {
  const entry = pendingCalls.get(callId);
  if (!entry) return Promise.resolve(null);

  // If already connected
  if (entry.gatewaySocket) return Promise.resolve(entry.gatewaySocket);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (entry.onMediaConnected) {
        entry.onMediaConnected = null;
      }
      resolve(null);
    }, timeoutMs);

    entry.onMediaConnected = (ws) => {
      clearTimeout(timer);
      resolve(ws);
    };
  });
}

/**
 * Get a pending call by callId.
 */
export function getPendingCall(callId: string): PendingCall | undefined {
  return pendingCalls.get(callId);
}

/**
 * Remove a pending call from the registry.
 */
export function removePendingCall(callId: string): void {
  pendingCalls.delete(callId);
}

/**
 * Send a JSON message to the gateway WebSocket for a given call.
 * Used by the bridge to send audio and control messages back to the gateway.
 */
export function sendToGateway(callId: string, message: Record<string, unknown>): void {
  const entry = pendingCalls.get(callId);
  if (!entry?.gatewaySocket) return;
  const ws = entry.gatewaySocket;
  if (ws.readyState === 1 /* WebSocket.OPEN */) {
    ws.send(JSON.stringify(message));
  }
}

// ─── Stale Entry Cleanup ────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [callId, entry] of pendingCalls) {
    if (now - entry.registeredAt > PENDING_CALL_TTL_MS && !entry.gatewaySocket) {
      pendingCalls.delete(callId);
    }
  }
}, 30_000);

// ─── Route Registration ─────────────────────────────────────────────

/**
 * Register SIP gateway callback routes on the Fastify instance.
 * Must be called after @fastify/websocket is registered.
 */
export async function registerSipRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /api/v1/sip-events — Lifecycle events from gateway ───────

  app.post<{ Body: SipLifecycleEvent }>("/api/v1/sip-events", async (request, reply) => {
    const body = request.body as SipLifecycleEvent;

    // Verify gateway secret if configured
    if (config.sipGatewayEventsSecret) {
      const secret = request.headers["x-sip-gateway-secret"];
      if (secret !== config.sipGatewayEventsSecret) {
        app.log.warn(
          { callId: body?.callId, event: body?.event },
          "SIP event rejected: invalid gateway secret"
        );
        return reply.code(401).send({ error: "Invalid gateway secret" });
      }
    }

    if (!body?.callId || !body?.event) {
      return reply.code(400).send({ error: "Missing callId or event" });
    }

    const entry = pendingCalls.get(body.callId);
    if (!entry) {
      app.log.warn(
        { callId: body.callId, event: body.event },
        "SIP event for unknown call — may have expired or not yet registered"
      );
      // Return 200 anyway to avoid gateway retries for calls we don't track
      return { received: true, matched: false };
    }

    // Store sipCallId from gateway
    if (body.sipCallId && !entry.sipCallId) {
      entry.sipCallId = body.sipCallId;
    }

    // Track event
    entry.lifecycleEvents.push(body);

    app.log.info(
      {
        callId: body.callId,
        sipCallId: body.sipCallId,
        event: body.event,
        previousStatus: entry.status,
      },
      "SIP lifecycle event received"
    );

    // Update status based on event
    switch (body.event) {
      case "dialing":
        entry.status = "dialing";
        break;
      case "ringing":
        entry.status = "ringing";
        break;
      case "connected":
        entry.status = "connected";
        if (entry.mediaEvents) {
          entry.mediaEvents.onCallConnected({
            from: body.phoneNumber,
            to: body.phoneNumber,
            streamId: body.sipCallId,
          });
        }
        break;
      case "media_connected":
        // Gateway's media bridge is ready — audio can flow
        break;
      case "ended":
        entry.status = "ended";
        if (entry.mediaEvents) {
          entry.mediaEvents.onCallEnded(body.reason || "call_ended");
        }
        break;
      case "failed":
      case "bridge_failed":
        entry.status = "failed";
        if (entry.mediaEvents) {
          entry.mediaEvents.onCallEnded(body.reason || body.event);
        }
        break;
      default:
        app.log.info(
          { callId: body.callId, event: body.event },
          "Unhandled SIP lifecycle event type"
        );
    }

    return { received: true, matched: true, status: entry.status };
  });

  // ── GET /api/v1/media-stream — WebSocket for gateway audio ────────

  app.get("/api/v1/media-stream", { websocket: true }, (socket, request) => {
    // The gateway connects here with query params to identify the call
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const callId =
      url.searchParams.get("callId") ||
      url.searchParams.get("call_id") ||
      null;
    const sipCallId =
      url.searchParams.get("sipCallId") ||
      url.searchParams.get("sip_call_id") ||
      null;

    // Find the pending call
    let entry: PendingCall | undefined;
    if (callId) {
      entry = pendingCalls.get(callId);
    }
    if (!entry && sipCallId) {
      // Fallback: search by sipCallId
      for (const [, e] of pendingCalls) {
        if (e.sipCallId === sipCallId) {
          entry = e;
          break;
        }
      }
    }

    if (!entry) {
      app.log.warn(
        { callId, sipCallId },
        "Media WebSocket rejected: no matching pending call"
      );
      socket.close(4004, "No matching pending call");
      return;
    }

    app.log.info(
      { callId: entry.callId, sipCallId: entry.sipCallId },
      "Gateway media WebSocket connected"
    );

    entry.gatewaySocket = socket;

    // Notify anyone waiting for the media connection
    if (entry.onMediaConnected) {
      entry.onMediaConnected(socket);
      entry.onMediaConnected = null;
    }

    // ── Handle messages from the gateway ──────────────────────────

    socket.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString());

        // "start" — Asterisk media started, audio can flow
        if (payload.event === "start") {
          entry!.status = "media_connected";
          app.log.info(
            {
              callId: entry!.callId,
              streamId: payload.streamId,
            },
            "Gateway media stream started"
          );

          if (entry!.mediaEvents) {
            entry!.mediaEvents.onCallConnected({
              from: payload.from,
              to: payload.to,
              streamId: payload.streamId,
            });
          }
          return;
        }

        // "media" — caller audio from Asterisk
        if (payload.event === "media" && payload.audio?.data) {
          if (entry!.mediaEvents) {
            entry!.mediaEvents.onAudio(
              payload.audio.data,
              payload.audio.mimeType || "audio/pcm;rate=8000;codec=ulaw"
            );
          }
          return;
        }

        // "stop" — Asterisk media ended
        if (payload.event === "stop") {
          app.log.info(
            { callId: entry!.callId },
            "Gateway media stream stopped"
          );
          if (entry!.mediaEvents) {
            entry!.mediaEvents.onCallEnded(payload.reason || "media_stopped");
          }
          return;
        }

        // Unknown event
        app.log.info(
          { callId: entry!.callId, event: payload.event },
          "Unknown gateway media message event"
        );
      } catch (err) {
        app.log.error(
          { err, callId: entry!.callId },
          "Failed to parse gateway media WebSocket message"
        );
      }
    });

    socket.on("close", (code, reason) => {
      const reasonStr = Buffer.isBuffer(reason) ? reason.toString() : String(reason);
      app.log.info(
        { callId: entry!.callId, code, reason: reasonStr },
        "Gateway media WebSocket closed"
      );

      entry!.gatewaySocket = null;

      // If the socket closes unexpectedly, notify the bridge
      if (code !== 1000 && entry!.mediaEvents) {
        entry!.mediaEvents.onCallEnded(`gateway_ws_closed_${code}`);
      }
    });

    socket.on("error", (err) => {
      app.log.error(
        { err, callId: entry!.callId },
        "Gateway media WebSocket error"
      );
      if (entry!.mediaEvents) {
        entry!.mediaEvents.onError(err);
      }
    });
  });
}
