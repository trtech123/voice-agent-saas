import "dotenv/config";
import WebSocket from "ws";

const ASTERISK_MEDIA_FORMAT = String(process.env.ASTERISK_MEDIA_FORMAT || "ulaw").toLowerCase();
const HALF_DUPLEX_RELEASE_MS = Number(process.env.ASTERISK_HALF_DUPLEX_RELEASE_MS || 200);
const ASTERISK_PLAYOUT_FRAME_MS = Number(process.env.ASTERISK_PLAYOUT_FRAME_MS || 20);

function getAsteriskFrameSizeBytes() {
  if (ASTERISK_MEDIA_FORMAT === "slin16") {
    return (16000 * ASTERISK_PLAYOUT_FRAME_MS / 1000) * 2;
  }
  return 8000 * ASTERISK_PLAYOUT_FRAME_MS / 1000;
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

/**
 * Simple pass-through audio encoding.
 * The SaaS gateway sends raw PCM audio from the voice engine; Asterisk
 * expects the same format (ulaw or slin16). No Gemini-specific transcoding
 * is needed here -- the voice engine handles that before sending to us.
 *
 * For the initial deployment we relay base64-encoded audio blobs as raw
 * binary buffers. If the voice engine sends JSON-wrapped audio with a
 * base64 `data` field, we decode it into a binary Buffer for Asterisk.
 */
function decodeAudioForAsterisk(audioBase64) {
  return Buffer.from(audioBase64, "base64");
}

function encodeAudioForVoiceEngine(audioBuffer) {
  return Buffer.from(audioBuffer).toString("base64");
}

export function registerGatewayMediaSocket(app, gatewayState) {
  app.get("/asterisk-media", { websocket: true }, (asteriskSocket, request) => {
    const url = new URL(request.url, "http://localhost");
    const callId = url.searchParams.get("callId") || url.searchParams.get("call_id");
    const sipCallId = url.searchParams.get("sipCallId") || url.searchParams.get("sip_call_id");

    const call = gatewayState.findCall({ callId, sipCallId });
    if (!call) {
      app.log.warn({ callId, sipCallId }, "Rejected Asterisk media connection for unknown call");
      asteriskSocket.close();
      return;
    }

    const voiceAgentSocket = new WebSocket(call.mediaStreamUrl);
    const mediaState = {
      asteriskSocket,
      voiceAgentSocket,
      started: false,
      optimalFrameSize: getAsteriskFrameSizeBytes(),
      queuePaused: false,
      outboundChunkCount: 0,
      inboundChunkCount: 0,
      suppressInboundUntil: 0,
      suppressedInboundChunkCount: 0,
      protectedAssistantTurnActive: false,
      assistantTurnStartedAt: null,
      assistantTurnStartedOutboundChunkCount: 0,
      assistantTurnStartedSuppressedInboundChunkCount: 0,
      firstOutboundChunkAt: null,
      lastOutboundChunkAt: null,
      lastInboundChunkAt: null,
      pendingFrameBuffer: Buffer.alloc(0),
      totalBytesSent: 0,
      totalSendCalls: 0,
      xoffEventsCount: 0,
      xoffDroppedBytes: 0,
      turnBytesSent: 0,
      turnSendCalls: 0,
      turnXoffEvents: 0,
    };

    gatewayState.attachMedia(call.sipCallId, mediaState);

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
        mediaState.turnXoffEvents += 1;
        mediaState.xoffDroppedBytes += toSend.length;
        app.log.warn(
          { sipCallId: call.sipCallId, droppedBytes: toSend.length },
          "XOFF active, dropping audio",
        );
        return;
      }

      asteriskSocket.send(toSend, { binary: true });
      mediaState.totalBytesSent += toSend.length;
      mediaState.totalSendCalls += 1;
      mediaState.turnBytesSent += toSend.length;
      mediaState.turnSendCalls += 1;
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
      mediaState.turnBytesSent += paddedFrame.length;
      mediaState.turnSendCalls += 1;
      app.log.info(
        { sipCallId: call.sipCallId, reason, partialBytes: paddedFrame.length },
        "Flushed partial frame with silence padding",
      );
    }

    voiceAgentSocket.on("open", () => {
      app.log.info({ callId: call.callId, sipCallId: call.sipCallId }, "Connected media bridge to voice-agent");
    });

    voiceAgentSocket.on("message", async (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        if (payload.event === "assistant_turn_state") {
          const now = new Date().toISOString();
          const wasProtected = mediaState.protectedAssistantTurnActive;
          mediaState.protectedAssistantTurnActive = Boolean(payload.protected);

          if (mediaState.protectedAssistantTurnActive) {
            mediaState.suppressInboundUntil = Number.MAX_SAFE_INTEGER;
          }

          if (mediaState.protectedAssistantTurnActive && !wasProtected) {
            mediaState.assistantTurnStartedAt = now;
            mediaState.assistantTurnStartedOutboundChunkCount = mediaState.outboundChunkCount;
            mediaState.assistantTurnStartedSuppressedInboundChunkCount =
              mediaState.suppressedInboundChunkCount;
            mediaState.turnBytesSent = 0;
            mediaState.turnSendCalls = 0;
            mediaState.turnXoffEvents = 0;
          } else if (!mediaState.protectedAssistantTurnActive && wasProtected) {
            flushPendingPartialFrame("turn_complete");
            mediaState.suppressInboundUntil = Date.now() + HALF_DUPLEX_RELEASE_MS;
            app.log.info(
              {
                sipCallId: call.sipCallId,
                phase: payload.phase || null,
                turnIndex: payload.turnIndex || null,
                assistantTurnStartedAt: mediaState.assistantTurnStartedAt,
                assistantTurnEndedAt: now,
                outboundChunksDuringTurn:
                  mediaState.outboundChunkCount - mediaState.assistantTurnStartedOutboundChunkCount,
                suppressedInboundChunksDuringTurn:
                  mediaState.suppressedInboundChunkCount -
                  mediaState.assistantTurnStartedSuppressedInboundChunkCount,
                turnBytesSent: mediaState.turnBytesSent,
                turnSendCalls: mediaState.turnSendCalls,
                turnXoffEvents: mediaState.turnXoffEvents,
                wsBufferedAmount: asteriskSocket.bufferedAmount,
                releaseAt: new Date(mediaState.suppressInboundUntil).toISOString(),
              },
              "Assistant turn complete, audio sent immediately to Asterisk",
            );
            mediaState.assistantTurnStartedAt = null;
          }

          app.log.info(
            {
              sipCallId: call.sipCallId,
              protectedAssistantTurnActive: mediaState.protectedAssistantTurnActive,
              phase: payload.phase || null,
              turnIndex: payload.turnIndex || null,
              suppressInboundUntil:
                mediaState.suppressInboundUntil === Number.MAX_SAFE_INTEGER
                  ? "assistant_playback_active"
                  : mediaState.suppressInboundUntil > 0
                    ? new Date(mediaState.suppressInboundUntil).toISOString()
                    : null,
            },
            "Updated assistant turn half-duplex gate",
          );
          return;
        }

        if (payload.event === "gemini_disconnected") {
          if (mediaState.protectedAssistantTurnActive) {
            flushPendingPartialFrame("gemini_disconnected");
            mediaState.protectedAssistantTurnActive = false;
            mediaState.suppressInboundUntil = Date.now() + HALF_DUPLEX_RELEASE_MS;
            mediaState.assistantTurnStartedAt = null;
          }
          app.log.warn(
            {
              sipCallId: call.sipCallId,
              code: payload.code ?? null,
              reason: payload.reason ?? null,
            },
            "Voice-agent Gemini WebSocket closed; half-duplex cleared if still protected",
          );
          return;
        }

        if (payload.event !== "media" || !payload.audio?.data) {
          return;
        }

        const encodedBuffer = decodeAudioForAsterisk(payload.audio.data);
        const now = new Date().toISOString();
        mediaState.firstOutboundChunkAt ||= now;
        mediaState.lastOutboundChunkAt = now;
        mediaState.outboundChunkCount += 1;
        sendToAsterisk(encodedBuffer);

        if (mediaState.outboundChunkCount === 1 || mediaState.outboundChunkCount % 25 === 0) {
          app.log.info(
            {
              sipCallId: call.sipCallId,
              outboundChunkCount: mediaState.outboundChunkCount,
              asteriskMediaFormat: ASTERISK_MEDIA_FORMAT,
              encodedBytes: encodedBuffer.length,
              totalBytesSent: mediaState.totalBytesSent,
              totalSendCalls: mediaState.totalSendCalls,
              wsBufferedAmount: asteriskSocket.bufferedAmount,
              pendingPartialBytes: mediaState.pendingFrameBuffer.length,
            },
            "Sent voice-agent audio to Asterisk",
          );
        }
      } catch (error) {
        app.log.error({ error, sipCallId: call.sipCallId }, "Failed to relay voice-agent media to Asterisk");
      }
    });

    voiceAgentSocket.on("close", async (code, reasonBuffer) => {
      const reason =
        Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0 ? reasonBuffer.toString() : "";
      app.log.warn(
        {
          sipCallId: call.sipCallId,
          code,
          reason,
          outboundChunkCount: mediaState.outboundChunkCount,
          inboundChunkCount: mediaState.inboundChunkCount,
          suppressedInboundChunkCount: mediaState.suppressedInboundChunkCount,
          firstOutboundChunkAt: mediaState.firstOutboundChunkAt,
          lastOutboundChunkAt: mediaState.lastOutboundChunkAt,
          lastInboundChunkAt: mediaState.lastInboundChunkAt,
          protectedAssistantTurnActive: mediaState.protectedAssistantTurnActive,
          totalBytesSent: mediaState.totalBytesSent,
          totalSendCalls: mediaState.totalSendCalls,
          xoffEventsCount: mediaState.xoffEventsCount,
          xoffDroppedBytes: mediaState.xoffDroppedBytes,
          pendingPartialBytes: mediaState.pendingFrameBuffer.length,
        },
        "Voice-agent media socket closed",
      );
      await gatewayState.failCall(call.sipCallId, "voice_agent_media_closed");
      if (asteriskSocket.readyState === WebSocket.OPEN) {
        asteriskSocket.close();
      }
    });

    voiceAgentSocket.on("error", async (error) => {
      app.log.error({ error, sipCallId: call.sipCallId }, "Voice-agent media socket error");
      await gatewayState.failCall(call.sipCallId, "voice_agent_media_error");
    });

    asteriskSocket.on("message", async (message, isBinary) => {
      try {
        if (isBinary) {
          if (voiceAgentSocket.readyState !== WebSocket.OPEN || !mediaState.started) {
            return;
          }

          mediaState.inboundChunkCount += 1;
          mediaState.lastInboundChunkAt = new Date().toISOString();

          const playbackGateActive =
            mediaState.protectedAssistantTurnActive ||
            Date.now() < mediaState.suppressInboundUntil;
          if (playbackGateActive) {
            mediaState.suppressedInboundChunkCount += 1;
            if (
              mediaState.suppressedInboundChunkCount === 1 ||
              mediaState.suppressedInboundChunkCount % 50 === 0
            ) {
              app.log.warn(
                {
                  sipCallId: call.sipCallId,
                  inboundChunkCount: mediaState.inboundChunkCount,
                  suppressedInboundChunkCount: mediaState.suppressedInboundChunkCount,
                  protectedAssistantTurnActive: mediaState.protectedAssistantTurnActive,
                  suppressInboundUntil:
                    mediaState.suppressInboundUntil === Number.MAX_SAFE_INTEGER
                      ? "assistant_playback_active"
                      : mediaState.suppressInboundUntil > 0
                        ? new Date(mediaState.suppressInboundUntil).toISOString()
                        : null,
                },
                "Suppressing caller audio: half-duplex gate active",
              );
            }
            return;
          }

          const audioBase64 = encodeAudioForVoiceEngine(Buffer.from(message));
          voiceAgentSocket.send(
            JSON.stringify({
              event: "media",
              callId: call.callId,
              audio: {
                data: audioBase64,
                mimeType: ASTERISK_MEDIA_FORMAT === "slin16"
                  ? "audio/pcm;rate=16000"
                  : "audio/pcm;rate=8000;codec=ulaw",
              },
            }),
          );

          if (mediaState.inboundChunkCount === 1 || mediaState.inboundChunkCount % 50 === 0) {
            app.log.info(
              {
                sipCallId: call.sipCallId,
                inboundChunkCount: mediaState.inboundChunkCount,
                asteriskMediaFormat: ASTERISK_MEDIA_FORMAT,
                binaryBytes: Buffer.from(message).length,
              },
              "Relaying caller audio to voice-agent",
            );
          }
          return;
        }

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
          if (voiceAgentSocket.readyState === WebSocket.OPEN) {
            voiceAgentSocket.send(
              JSON.stringify({
                event: "start",
                callId: call.callId,
                streamId: control.connection_id || call.sipCallId,
                from: call.phoneNumber,
                to: call.phoneNumber,
              }),
            );
          }
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
          suppressedInboundChunkCount: mediaState.suppressedInboundChunkCount,
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
      if (voiceAgentSocket.readyState === WebSocket.OPEN) {
        voiceAgentSocket.send(JSON.stringify({ event: "stop", callId: call.callId }));
        voiceAgentSocket.close();
      }
      await gatewayState.endCall(call.sipCallId, "media_socket_closed");
    });

    asteriskSocket.on("error", async (error) => {
      app.log.error({ error, sipCallId: call.sipCallId }, "Asterisk media websocket error");
      await gatewayState.failCall(call.sipCallId, "asterisk_media_error");
    });
  });
}
