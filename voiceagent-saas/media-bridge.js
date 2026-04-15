// voiceagent-saas/media-bridge.js

/**
 * Media Bridge — Connects Asterisk ExternalMedia WebSocket to CallBridge directly.
 *
 * Adapted from asterisk-gateway/media-bridge.js for the merged deployment.
 *
 * Key differences from the gateway version:
 * - No WebSocket to a remote voice engine. Instead, looks up the active CallBridge
 *   for each call from the shared call-bridge registry.
 * - Asterisk binary audio is passed directly to callBridge.handleCallerAudio(Buffer).
 * - CallBridge output wired via callBridge.sendToAsterisk callback.
 * - On Asterisk WebSocket close: callBridge.cleanup().
 * - Keeps Asterisk frame-align logic, playout pacing, XOFF/XON, and half-duplex
 *   control from the original.
 */

import WebSocket from "ws";
import crypto from "node:crypto";
import { getActiveBridge } from "./call-bridge.js";

const ASTERISK_MEDIA_FORMAT = String(process.env.ASTERISK_MEDIA_FORMAT || "slin16").toLowerCase();
const ASTERISK_PLAYOUT_FRAME_MS = Number(process.env.ASTERISK_PLAYOUT_FRAME_MS || 20);

function getAsteriskFrameSizeBytes() {
  if (ASTERISK_MEDIA_FORMAT === "slin16") {
    return (16000 * ASTERISK_PLAYOUT_FRAME_MS / 1000) * 2;
  }
  return 8000 * ASTERISK_PLAYOUT_FRAME_MS / 1000;
}

/**
 * Split a frame-aligned buffer into chunks that each fit under Asterisk's
 * WebSocket RX payload limit (AST_WEBSOCKET_MAX_RX_PAYLOAD_SIZE = 65535).
 * Each chunk is a multiple of `frameSize` so playout stays frame-aligned.
 *
 * Sending a single ws frame > ~65KB triggers "Cannot fit huge websocket
 * frame" in res_http_websocket.c and closes the channel with code 1009,
 * which surfaces as ARI ChannelHangupRequest cause 38 "Network out of
 * order" — observed in production with ~80KB agent_audio bursts.
 *
 * @param {Buffer} buffer - the frame-aligned payload to split
 * @param {number} frameSize - one audio frame in bytes (e.g., 640 for slin16 20ms)
 * @param {number} maxBytes - max payload per send (default 32768 = 32KB, safe margin)
 * @returns {Buffer[]}
 */
export function chunkForAsteriskWs(buffer, frameSize, maxBytes = 32768) {
  if (!buffer || buffer.length === 0) return [];
  if (!Number.isInteger(frameSize) || frameSize <= 0) {
    throw new Error(`chunkForAsteriskWs: invalid frameSize ${frameSize}`);
  }
  // Round maxBytes down to a multiple of frameSize so each slice is aligned.
  const framesPerChunk = Math.floor(maxBytes / frameSize);
  if (framesPerChunk < 1) {
    throw new Error(
      `chunkForAsteriskWs: frameSize ${frameSize} larger than maxBytes ${maxBytes}`,
    );
  }
  const chunkSize = framesPerChunk * frameSize;
  if (buffer.length <= chunkSize) {
    return [buffer];
  }
  const out = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    out.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return out;
}

function parseAsteriskControlMessage(message) {
  const text = message.toString();
  try {
    return JSON.parse(text);
  } catch {
    const [eventName, ...parts] = text.trim().split(/\s+/);
    const payload = { event: eventName };
    for (const part of parts) {
      const [key, value] = part.split(":");
      if (!key || value === undefined) continue;
      payload[key] = value;
    }
    return payload;
  }
}

export function registerGatewayMediaSocket(app, gatewayState) {
  app.get("/asterisk-media", { websocket: true }, (asteriskSocket, request) => {
    const url = new URL(request.url, "http://localhost");
    
    // Auth validation
    const token = url.searchParams.get("token");
    const expectedToken = process.env.SIP_GATEWAY_API_KEY;
    if (!expectedToken || !token || token.length !== expectedToken.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken))) {
      app.log.warn("Rejected Asterisk media connection: unauthorized token");
      asteriskSocket.close(1008, "Unauthorized");
      return;
    }

    const callId = url.searchParams.get("callId") || url.searchParams.get("call_id");
    const sipCallId = url.searchParams.get("sipCallId") || url.searchParams.get("sip_call_id");

    const call = gatewayState.findCall({ callId, sipCallId });
    if (!call) {
      app.log.warn({ callId, sipCallId }, "Rejected Asterisk media connection for unknown call");
      asteriskSocket.close();
      return;
    }

    // Look up the active CallBridge for this call from the shared registry
    const callBridge = getActiveBridge(callId || call.callId);
    if (!callBridge) {
      app.log.warn(
        { callId: call.callId, sipCallId: call.sipCallId },
        "Rejected Asterisk media connection: no active CallBridge for this call"
      );
      asteriskSocket.close();
      return;
    }

    const mediaState = {
      asteriskSocket,
      started: false,
      optimalFrameSize: getAsteriskFrameSizeBytes(),
      queuePaused: false,
      outboundChunkCount: 0,
      inboundChunkCount: 0,
      firstOutboundChunkAt: null,
      lastOutboundChunkAt: null,
      lastInboundChunkAt: null,
      pendingFrameBuffer: Buffer.alloc(0),
      totalBytesSent: 0,
      totalSendCalls: 0,
      xoffEventsCount: 0,
      xoffDroppedBytes: 0,
    };

    gatewayState.attachMedia(call.sipCallId, mediaState);

    // ─── Frame-aligned playout to Asterisk ─────────────────────────

    function sendToAsterisk(encodedBuffer) {
      if (!encodedBuffer.length) return;

      mediaState.pendingFrameBuffer = Buffer.concat([mediaState.pendingFrameBuffer, encodedBuffer]);

      const frameSize = mediaState.optimalFrameSize;
      const completeBytes = Math.floor(mediaState.pendingFrameBuffer.length / frameSize) * frameSize;
      if (completeBytes === 0) return;

      const toSend = mediaState.pendingFrameBuffer.subarray(0, completeBytes);
      mediaState.pendingFrameBuffer = mediaState.pendingFrameBuffer.subarray(completeBytes);

      if (!mediaState.started || asteriskSocket.readyState !== WebSocket.OPEN) return;

      if (mediaState.queuePaused) {
        mediaState.xoffEventsCount += 1;
        mediaState.xoffDroppedBytes += toSend.length;
        app.log.warn(
          { sipCallId: call.sipCallId, droppedBytes: toSend.length },
          "XOFF active, dropping audio",
        );
        return;
      }

      // Chunk into frame-aligned pieces under Asterisk's WebSocket RX limit
      // (AST_WEBSOCKET_MAX_RX_PAYLOAD_SIZE = 65535). See chunkForAsteriskWs.
      const chunks = chunkForAsteriskWs(toSend, frameSize);
      for (const slice of chunks) {
        asteriskSocket.send(slice, { binary: true });
        mediaState.totalBytesSent += slice.length;
        mediaState.totalSendCalls += 1;
      }
    }

    function flushPendingPartialFrame(reason) {
      if (mediaState.pendingFrameBuffer.length === 0) return;

      const silenceByte = ASTERISK_MEDIA_FORMAT === "ulaw" ? 0xFF : 0x00;
      const paddedFrame = Buffer.alloc(mediaState.optimalFrameSize, silenceByte);
      mediaState.pendingFrameBuffer.copy(paddedFrame, 0);
      mediaState.pendingFrameBuffer = Buffer.alloc(0);

      if (!mediaState.started || asteriskSocket.readyState !== WebSocket.OPEN || mediaState.queuePaused) return;

      asteriskSocket.send(paddedFrame, { binary: true });
      mediaState.totalBytesSent += paddedFrame.length;
      mediaState.totalSendCalls += 1;
      app.log.info(
        { sipCallId: call.sipCallId, reason, partialBytes: paddedFrame.length },
        "Flushed partial frame with silence padding",
      );
    }

    // ─── Wire CallBridge output to Asterisk ────────────────────────
    // CallBridge.handleGeminiAudio calls this.sendToAsterisk(base64)
    // We decode the base64 back to a Buffer and feed it through the
    // frame-aligned playout pipeline.
    callBridge.sendToAsterisk = (base64) => {
      const buf = Buffer.from(base64, "base64");

      const now = new Date().toISOString();
      mediaState.firstOutboundChunkAt ||= now;
      mediaState.lastOutboundChunkAt = now;
      mediaState.outboundChunkCount += 1;

      sendToAsterisk(buf);

      if (mediaState.outboundChunkCount === 1 || mediaState.outboundChunkCount % 25 === 0) {
        app.log.info(
          {
            sipCallId: call.sipCallId,
            outboundChunkCount: mediaState.outboundChunkCount,
            asteriskMediaFormat: ASTERISK_MEDIA_FORMAT,
            encodedBytes: buf.length,
            totalBytesSent: mediaState.totalBytesSent,
            totalSendCalls: mediaState.totalSendCalls,
            wsBufferedAmount: asteriskSocket.bufferedAmount,
            pendingPartialBytes: mediaState.pendingFrameBuffer.length,
          },
          "Sent CallBridge audio to Asterisk",
        );
      }
    };

    // ─── Asterisk -> CallBridge (caller audio + control) ───────────

    asteriskSocket.on("message", async (message, isBinary) => {
      try {
        if (isBinary) {
          if (!mediaState.started) return;

          mediaState.inboundChunkCount += 1;
          mediaState.lastInboundChunkAt = new Date().toISOString();

          // Pass raw Buffer directly to CallBridge — no JSON, no base64
          callBridge.handleCallerAudio(Buffer.from(message));

          if (mediaState.inboundChunkCount === 1 || mediaState.inboundChunkCount % 50 === 0) {
            app.log.info(
              {
                sipCallId: call.sipCallId,
                inboundChunkCount: mediaState.inboundChunkCount,
                asteriskMediaFormat: ASTERISK_MEDIA_FORMAT,
                binaryBytes: Buffer.from(message).length,
              },
              "Relaying caller audio to CallBridge",
            );
          }
          return;
        }

        // Text message — Asterisk control events
        const control = parseAsteriskControlMessage(message);
        const eventName = control.event || control.type;

        if (eventName === "MEDIA_START") {
          mediaState.started = true;
          const reportedOptimalFrameSize = Number(control.optimal_frame_size) || null;
          if (reportedOptimalFrameSize && reportedOptimalFrameSize !== mediaState.optimalFrameSize) {
            mediaState.optimalFrameSize = reportedOptimalFrameSize;
            app.log.info(
              { sipCallId: call.sipCallId, optimalFrameSize: reportedOptimalFrameSize },
              "Adopted Asterisk-reported optimal frame size",
            );
          }
          app.log.info(
            {
              sipCallId: call.sipCallId,
              connectionId: control.connection_id || null,
              optimalFrameSize: mediaState.optimalFrameSize,
              channel: control.channel || null,
            },
            "Asterisk media websocket started",
          );
          await gatewayState.noteMediaStarted(call.sipCallId, control.connection_id || null);
          return;
        }

        if (eventName === "MEDIA_XOFF") {
          mediaState.queuePaused = true;
          app.log.warn({ sipCallId: call.sipCallId }, "Asterisk media queue paused");
          return;
        }

        if (eventName === "MEDIA_XON") {
          mediaState.queuePaused = false;
          app.log.info({ sipCallId: call.sipCallId }, "Asterisk media resumed (XON)");
          return;
        }

        if (eventName === "STATUS" && control.optimal_frame_size) {
          const reportedOptimalFrameSize = Number(control.optimal_frame_size) || null;
          if (reportedOptimalFrameSize && reportedOptimalFrameSize !== mediaState.optimalFrameSize) {
            app.log.info(
              {
                sipCallId: call.sipCallId,
                reportedOptimalFrameSize,
                playoutFrameSizeBytes: mediaState.optimalFrameSize,
              },
              "Asterisk status reported current frame size",
            );
          }
          return;
        }
      } catch (error) {
        app.log.error({ error, sipCallId: call.sipCallId }, "Failed to process Asterisk media websocket message");
      }
    });

    // ─── Asterisk WebSocket close -> CallBridge cleanup ────────────

    asteriskSocket.on("close", async (code, reasonBuffer) => {
      const reason =
        Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0 ? reasonBuffer.toString() : "";
      gatewayState.detachMedia(call.sipCallId);
      app.log.warn(
        {
          sipCallId: call.sipCallId,
          code,
          reason,
          started: mediaState.started,
          outboundChunkCount: mediaState.outboundChunkCount,
          inboundChunkCount: mediaState.inboundChunkCount,
          firstOutboundChunkAt: mediaState.firstOutboundChunkAt,
          lastOutboundChunkAt: mediaState.lastOutboundChunkAt,
          lastInboundChunkAt: mediaState.lastInboundChunkAt,
          totalBytesSent: mediaState.totalBytesSent,
          totalSendCalls: mediaState.totalSendCalls,
          xoffEventsCount: mediaState.xoffEventsCount,
          xoffDroppedBytes: mediaState.xoffDroppedBytes,
          pendingPartialBytes: mediaState.pendingFrameBuffer.length,
        },
        "Asterisk media websocket closed",
      );

      // Tell the CallBridge to clean up (ends the Gemini session, resolves the bridge promise)
      callBridge.cleanup();

      await gatewayState.endCall(call.sipCallId, "media_socket_closed");
    });

    asteriskSocket.on("error", async (error) => {
      app.log.error({ error, sipCallId: call.sipCallId }, "Asterisk media websocket error");
      await gatewayState.failCall(call.sipCallId, "asterisk_media_error");
    });
  });
}
