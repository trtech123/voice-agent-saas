// voiceagent-saas/server.js

/**
 * Merged Server — Combines the Asterisk gateway and voice engine into a
 * single Node.js process on the DigitalOcean droplet.
 *
 * Gateway: Fastify HTTP, ARI client, call management (POST /calls, GET /status, DELETE /calls/:sipCallId)
 * Voice engine: BullMQ worker via createCallWorker() from call-processor.js
 * Media bridge: registerGatewayMediaSocket() — Asterisk ExternalMedia -> CallBridge (direct Buffer)
 * Health: GET /health (active calls, Redis status, uptime, event loop lag)
 * Shutdown: SIGTERM/SIGINT -> stop worker -> drain active calls (30s) -> cleanup -> exit
 */

import "dotenv/config";
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import { ariRequest, ensureAriEventSocket, getAriStatus, subscribeToAriEvents } from "./ari-client.js";
import { registerGatewayMediaSocket } from "./media-bridge.js";
import { createCallWorker, createMonthlyResetScheduler } from "./call-processor.js";
import { getActiveBridgeCount, cleanupAllBridges } from "./call-bridge.js";
import { createClient } from "@supabase/supabase-js";
import { startLiveTurnWriter, stopLiveTurnWriter } from "./live-turn-writer.js";
import { startAgentSyncWorker, stopAgentSyncWorker } from "./agent-sync-processor.js";
import { startJanitor, stopJanitor } from "./janitor.js";

// ─── Required env validation ──────────────────────────────────────
// GEMINI_API_KEY is intentionally NOT validated here — Gemini has been
// removed from the call path, but the env var is kept alive for the 72h
// rollback window per the Spec A rollout plan.
const requiredEnv = [
  "ELEVENLABS_API_KEY",
  "SUPABASE_DIRECT_DB_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[boot] missing required env: ${key}`);
    process.exit(1);
  }
}

// ─── Environment ──────────────────────────────────────────────────

const {
  PORT = 8091,
  PUBLIC_BASE_URL,
  SIP_GATEWAY_API_KEY,
  SIP_GATEWAY_EVENTS_SECRET,
  VOICENTER_PJSIP_ENDPOINT = "voicenter_trunk",
  VOICENTER_SIP_SERVER,
  VOICENTER_SIP_USERNAME,
  VOICENTER_SIP_PASSWORD,
  VOICENTER_CALLER_ID,
  VOICENTER_TRANSPORT = "udp",
  ASTERISK_MEDIA_CONNECTION_NAME = "voiceagent_saas_media",
  ASTERISK_MEDIA_FORMAT = "slin16",
  ASTERISK_ARI_APP = "voiceagent-saas-media",
  REDIS_URL,
} = process.env;

// ─── Fastify Setup ────────────────────────────────────────────────

const fastify = Fastify({ logger: true });
await fastify.register(fastifyWs);

// ─── Gateway Call State ───────────────────────────────────────────

const callsBySipId = new Map();
const callIndexByCallId = new Map();
const channelToCall = new Map();

// ─── Utility Functions (from gateway server.js) ───────────────────

function getBaseUrl() {
  return PUBLIC_BASE_URL || `http://localhost:${PORT}`;
}

function verifyApiKey(request, reply) {
  if (!SIP_GATEWAY_API_KEY) {
    reply.code(503).send({ error: "SIP gateway API key is not configured" });
    return false;
  }
  const auth = request.headers.authorization || "";
  if (auth !== `Bearer ${SIP_GATEWAY_API_KEY}`) {
    reply.code(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function buildSignedHeaders() {
  return {
    "Content-Type": "application/json",
    ...(SIP_GATEWAY_EVENTS_SECRET
      ? { "x-sip-gateway-secret": SIP_GATEWAY_EVENTS_SECRET }
      : {}),
  };
}

function getMissingVoicenterConfig() {
  const required = [
    ["VOICENTER_SIP_SERVER", VOICENTER_SIP_SERVER],
    ["VOICENTER_SIP_USERNAME", VOICENTER_SIP_USERNAME],
    ["VOICENTER_SIP_PASSWORD", VOICENTER_SIP_PASSWORD],
    ["VOICENTER_CALLER_ID", VOICENTER_CALLER_ID],
  ];
  return required.filter(([, value]) => !value).map(([name]) => name);
}

function getVoicenterStatus() {
  const missing = getMissingVoicenterConfig();
  return {
    configured: missing.length === 0,
    pjsipEndpoint: VOICENTER_PJSIP_ENDPOINT,
    sipServerConfigured: Boolean(VOICENTER_SIP_SERVER),
    credentialsConfigured: Boolean(VOICENTER_SIP_USERNAME && VOICENTER_SIP_PASSWORD),
    callerIdConfigured: Boolean(VOICENTER_CALLER_ID),
    transport: VOICENTER_TRANSPORT,
    missing,
  };
}

function validateVoicenterConfig() {
  const { missing } = getVoicenterStatus();
  if (missing.length > 0) {
    throw new Error(
      `Voicenter SIP trunk is not configured. Missing: ${missing.join(", ")}`,
    );
  }
}

function normalizePhoneNumber(phoneNumber) {
  let digits = String(phoneNumber || "").replace(/[^\d+]/g, "");
  digits = digits.replace(/^\+/, "");
  if (digits.startsWith("972") && digits.length >= 12) {
    digits = "0" + digits.slice(3);
  }
  return digits || "";
}

function buildVoicenterDialTarget(phoneNumber) {
  const normalizedNumber = normalizePhoneNumber(phoneNumber);
  if (!normalizedNumber) {
    throw new Error("A valid target phone number is required");
  }
  const sipServer = "185.138.169.235";
  const sipUri = `sip:${normalizedNumber}@${sipServer}`;
  return `PJSIP/${VOICENTER_PJSIP_ENDPOINT}/${sipUri}`;
}

function normalizeDigits(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

// ─── ARI Event Helpers (from gateway server.js) ───────────────────

async function sendLifecycleEvent(call, event, extra = {}) {
  if (!call?.eventWebhookUrl) return;
  try {
    await fetch(call.eventWebhookUrl, {
      method: "POST",
      headers: buildSignedHeaders(),
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        callId: call.callId,
        sipCallId: call.sipCallId,
        phoneNumber: call.phoneNumber,
        tenantId: call.tenantId || null,
        event,
        ...extra,
      }),
    });
  } catch (error) {
    fastify.log.error({ error, sipCallId: call?.sipCallId }, "Failed to send lifecycle event");
  }
}

function findCall({ callId, sipCallId }) {
  if (sipCallId && callsBySipId.has(sipCallId)) {
    return callsBySipId.get(sipCallId);
  }
  if (callId && callIndexByCallId.has(callId)) {
    return callsBySipId.get(callIndexByCallId.get(callId));
  }
  return null;
}

function getChannelDebugFields(channel = {}) {
  return {
    id: channel.id || null,
    name: channel.name || null,
    state: channel.state || null,
    dialplan: channel.dialplan || null,
    caller: channel.caller || null,
    connected: channel.connected || null,
    dialed: channel.dialed || null,
  };
}

function getChannelRole(call, channel = {}) {
  if (!call || !channel?.id) return "unknown";
  if (channel.id === call.customerChannelId) return "customer";
  if (channel.id === call.mediaChannelId) return "media";
  return "unknown";
}

function getAriEventDebugFields(call, event) {
  return {
    type: event?.type || null,
    application: event?.application || null,
    timestamp: event?.timestamp || null,
    cause: event?.cause ?? null,
    causeTxt: event?.cause_txt || event?.causeTxt || null,
    channelRole: getChannelRole(call, event?.channel),
    channel: getChannelDebugFields(event?.channel),
  };
}

function isVoicenterCustomerChannel(channel = {}) {
  const name = String(channel.name || "");
  return name.includes(`PJSIP/${VOICENTER_PJSIP_ENDPOINT}`);
}

function channelMatchesPhoneNumber(channel = {}, phoneNumber) {
  const targetDigits = normalizeDigits(phoneNumber);
  if (!targetDigits) return false;
  const candidates = [
    channel.caller?.number,
    channel.connected?.number,
    channel.dialed?.number,
    channel.dialed?.exten,
    channel.connected?.name,
    channel.name,
  ];
  return candidates.some((candidate) => normalizeDigits(candidate).includes(targetDigits));
}

function findCallForCustomerChannel(channel = {}) {
  if (!isVoicenterCustomerChannel(channel)) return null;
  for (const call of callsBySipId.values()) {
    if (["failed", "ended"].includes(call.status)) continue;
    if (call.customerChannelId && call.customerChannelId === channel.id) return call;
    if (call.customerChannelName && call.customerChannelName === channel.name) return call;
    if (call.pendingCustomerChannelId && call.pendingCustomerChannelId === channel.id) return call;
    if (call.pendingCustomerChannelName && call.pendingCustomerChannelName === channel.name) return call;
    if (channelMatchesPhoneNumber(channel, call.phoneNumber)) return call;
  }
  return null;
}

function attachChannel(call, channelId, role) {
  if (!channelId) return;
  const previousChannelId =
    role === "customer" ? call.customerChannelId
      : role === "media" ? call.mediaChannelId
        : null;
  if (previousChannelId && previousChannelId !== channelId) {
    channelToCall.delete(previousChannelId);
  }
  channelToCall.set(channelId, call.sipCallId);
  if (role === "customer") call.customerChannelId = channelId;
  if (role === "media") call.mediaChannelId = channelId;
}

async function attachCustomerChannel(call, channel) {
  const channelId = channel?.id;
  if (!call || !channelId) return call;
  attachChannel(call, channelId, "customer");
  const nextCall = await markCall(call, call.status, {
    customerChannelId: channelId,
    customerChannelName: channel?.name || null,
    pendingCustomerChannelId: null,
    pendingCustomerChannelName: null,
  });
  fastify.log.info(
    {
      sipCallId: nextCall.sipCallId,
      bridgeId: nextCall.bridgeId,
      customerChannelId: channelId,
      customerChannelName: channel?.name || null,
    },
    "Attached Voicenter customer leg to call",
  );
  return nextCall;
}

async function addChannelToBridge(call, channelId) {
  if (!call?.bridgeId || !channelId) return;
  const role =
    channelId === call.mediaChannelId ? "media"
      : channelId === call.customerChannelId ? "customer"
        : "unknown";
  const alreadyAdded =
    (role === "media" && call.mediaBridgeAdded) ||
    (role === "customer" && call.customerBridgeAdded);
  if (alreadyAdded) return;

  try {
    await ariRequest("POST", `/bridges/${call.bridgeId}/addChannel`, {
      query: { channel: channelId },
    });
    await markCall(call, call.status, {
      ...(role === "media" ? { mediaBridgeAdded: true } : {}),
      ...(role === "customer" ? { customerBridgeAdded: true } : {}),
    });
    fastify.log.info(
      {
        sipCallId: call.sipCallId,
        bridgeId: call.bridgeId,
        role,
        channelId,
        customerChannelId: call.customerChannelId || null,
        mediaChannelId: call.mediaChannelId || null,
        bridgedChannelCount:
          (call.customerBridgeAdded ? 1 : 0) +
          (call.mediaBridgeAdded ? 1 : 0),
      },
      "Added channel to Asterisk bridge",
    );
  } catch (error) {
    fastify.log.error({ error, sipCallId: call.sipCallId, channelId }, "Failed to add channel to bridge");
  }
}

async function cleanupAsteriskResources(call) {
  const channelIds = [call.customerChannelId, call.mediaChannelId].filter(Boolean);
  for (const channelId of channelIds) {
    try { await ariRequest("DELETE", `/channels/${channelId}`); } catch {}
    channelToCall.delete(channelId);
  }
  if (call.bridgeId) {
    try { await ariRequest("DELETE", `/bridges/${call.bridgeId}`); } catch {}
  }
}

async function markCall(call, status, extra = {}) {
  const nextCall = {
    ...call,
    status,
    ...extra,
    updatedAt: new Date().toISOString(),
  };
  callsBySipId.set(call.sipCallId, nextCall);
  return nextCall;
}

// ─── Gateway State (shared with media-bridge) ─────────────────────

const gatewayState = {
  findCall,
  attachMedia(sipCallId, media) {
    const call = callsBySipId.get(sipCallId);
    if (!call) return;
    callsBySipId.set(sipCallId, { ...call, media });
  },
  detachMedia(sipCallId) {
    const call = callsBySipId.get(sipCallId);
    if (!call) return;
    const nextCall = { ...call };
    delete nextCall.media;
    callsBySipId.set(sipCallId, nextCall);
  },
  async noteMediaStarted(sipCallId, streamId) {
    const call = callsBySipId.get(sipCallId);
    if (!call) return;
    const nextCall = await markCall(call, "media_connected", { mediaStreamId: streamId });
    await sendLifecycleEvent(nextCall, "media_connected", { streamId });
  },
  async failCall(sipCallId, reason) {
    const call = callsBySipId.get(sipCallId);
    if (!call || ["failed", "ended"].includes(call.status)) return;
    const nextCall = await markCall(call, "bridge_failed", { failureReason: reason });
    await sendLifecycleEvent(nextCall, "bridge_failed", { reason });
    await cleanupAsteriskResources(nextCall);
  },
  async endCall(sipCallId, reason) {
    const call = callsBySipId.get(sipCallId);
    if (!call || call.status === "ended") return;
    const nextCall = await markCall(call, "ended", { failureReason: reason || null });
    await sendLifecycleEvent(nextCall, "ended", { reason: reason || null });
    await cleanupAsteriskResources(nextCall);
  },
};

// ─── Register Media Bridge (Asterisk WS -> CallBridge) ────────────

registerGatewayMediaSocket(fastify, gatewayState);

// ─── ARI Event Handler (from gateway server.js) ──────────────────

subscribeToAriEvents(async (event) => {
  const channelId = event.channel?.id || event.channel?.name || event.channel?.channel_id;
  const mappedSipCallId = channelId ? channelToCall.get(channelId) : null;
  let call = mappedSipCallId ? callsBySipId.get(mappedSipCallId) : null;

  if (event.type === "StasisStart") {
    fastify.log.info(
      {
        mappedSipCallId: mappedSipCallId || null,
        channel: getChannelDebugFields(event.channel),
      },
      "Received ARI StasisStart event",
    );

    if (!call && isVoicenterCustomerChannel(event.channel)) {
      call = findCallForCustomerChannel(event.channel);
      if (!call) {
        fastify.log.warn(
          { channel: getChannelDebugFields(event.channel) },
          "Ignoring unrelated Voicenter customer channel",
        );
        return;
      }
    }

    if (!call) return;

    if (event.channel?.id === call.mediaChannelId) {
      await addChannelToBridge(call, event.channel.id);
      return;
    }

    if (isVoicenterCustomerChannel(event.channel)) {
      const nextCall = await attachCustomerChannel(call, event.channel);
      await addChannelToBridge(nextCall, event.channel.id);
      return;
    }

    fastify.log.warn(
      { sipCallId: call.sipCallId, channel: getChannelDebugFields(event.channel) },
      "Ignoring unrelated channel for call bridge",
    );
    return;
  }

  if (!call) {
    if (!isVoicenterCustomerChannel(event.channel)) return;
    call = findCallForCustomerChannel(event.channel);
    if (!call) return;
  }

  if (event.type === "ChannelStateChange") {
    if (isVoicenterCustomerChannel(event.channel) && call.customerChannelId !== event.channel?.id) {
      call = await attachCustomerChannel(call, event.channel);
    }

    fastify.log.info(
      { sipCallId: call.sipCallId, channel: getChannelDebugFields(event.channel) },
      "Received ARI ChannelStateChange event",
    );

    const isCustomerLeg =
      isVoicenterCustomerChannel(event.channel) &&
      event.channel?.id === call.customerChannelId;
    if (!isCustomerLeg) return;

    const state = event.channel?.state;
    if (state === "Ringing") {
      const nextCall = await markCall(call, "ringing");
      await sendLifecycleEvent(nextCall, "ringing");
    } else if (state === "Up") {
      const nextCall = await markCall(call, "connected");
      await sendLifecycleEvent(nextCall, "connected");
    }
    return;
  }

  if (event.type === "ChannelHangupRequest" || event.type === "StasisEnd" || event.type === "ChannelDestroyed") {
    fastify.log.warn(
      { sipCallId: call.sipCallId, ...getAriEventDebugFields(call, event) },
      "Received ARI call-ending event",
    );
    await gatewayState.endCall(call.sipCallId, event.type);
  }
});

// ─── Core Call Initiation Function ────────────────────────────────
// This is the KEY integration point. When the BullMQ worker picks up
// a job, call-processor calls gatewayApi.initiateCall() which runs
// this function — creating the Asterisk channels, bridge, and media
// connection all in the same process.

async function initiateCall(phoneNumber, callId) {
  const sipCallId = crypto.randomUUID();
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) {
    return { success: false, error: "Invalid phone number" };
  }

  const bridgeId = `bridge-${sipCallId}`;
  const customerChannelId = `customer-${sipCallId}`;
  const mediaChannelId = `media-${sipCallId}`;

  const call = {
    callId,
    sipCallId,
    bridgeId,
    customerChannelId: null,
    customerChannelName: null,
    pendingCustomerChannelId: customerChannelId,
    pendingCustomerChannelName: null,
    mediaChannelId,
    phoneNumber: normalized,
    eventWebhookUrl: null, // No external webhook in merged mode
    mediaStreamUrl: null,  // No remote media URL in merged mode
    metadata: {},
    tenantId: null,
    customerBridgeAdded: false,
    mediaBridgeAdded: false,
    status: "creating",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  callsBySipId.set(sipCallId, call);
  callIndexByCallId.set(callId, sipCallId);
  attachChannel(call, mediaChannelId, "media");
  // Pre-register the customer channel so StasisStart can find the call
  channelToCall.set(customerChannelId, sipCallId);

  try {
    await ariRequest("POST", `/bridges/${bridgeId}`, {
      query: { type: "mixing", name: `voiceagent-saas-${sipCallId}` },
    });

    await ariRequest("POST", "/channels/externalMedia", {
      query: {
        app: ASTERISK_ARI_APP,
        channelId: mediaChannelId,
        external_host: ASTERISK_MEDIA_CONNECTION_NAME,
        transport: "websocket",
        encapsulation: "none",
        format: ASTERISK_MEDIA_FORMAT,
        transport_data: `f(json)v(callId=${callId},sipCallId=${sipCallId})`,
      },
    });

    const customerCreateResponse = await ariRequest("POST", "/channels", {
      query: {
        endpoint: buildVoicenterDialTarget(normalized),
        app: ASTERISK_ARI_APP,
        channelId: customerChannelId,
        callerId: VOICENTER_CALLER_ID,
      },
    });

    if (customerCreateResponse?.id || customerCreateResponse?.name) {
      await markCall(call, call.status, {
        pendingCustomerChannelId: customerCreateResponse.id || call.pendingCustomerChannelId,
        pendingCustomerChannelName: customerCreateResponse.name || null,
      });
    }

    const nextCall = await markCall(call, "dialing");
    await sendLifecycleEvent(nextCall, "dialing");

    return {
      success: true,
      sipCallId,
      status: nextCall.status,
      bridgeId,
      customerChannelId,
      mediaChannelId,
    };
  } catch (error) {
    const nextCall = await markCall(call, "failed", {
      failureReason: error instanceof Error ? error.message : "Failed to create Asterisk call",
    });
    await sendLifecycleEvent(nextCall, "failed", { reason: nextCall.failureReason });
    await cleanupAsteriskResources(nextCall);
    return {
      success: false,
      error: nextCall.failureReason,
      sipCallId,
      status: nextCall.status,
    };
  }
}

function getCallState(sipCallId) {
  return callsBySipId.get(sipCallId) || null;
}

// ─── HTTP Auth Hook ───────────────────────────────────────────────

fastify.addHook("onRequest", async (request, reply) => {
  if (request.method === "GET" && request.routerPath === "/status") return;
  if (request.method === "GET" && request.routerPath === "/health") return;
  if (request.method === "GET" && request.routerPath === "/healthz") return;
  if (request.raw.url?.startsWith("/asterisk-media")) return;
  if (!verifyApiKey(request, reply)) return reply;
});

// ─── HTTP Routes ──────────────────────────────────────────────────

fastify.get("/healthz", async () => ({ status: "ok" }));

// GET /health — comprehensive health endpoint
fastify.get("/health", async () => {
  const activeCalls = callsBySipId.size;
  const activeBridges = getActiveBridgeCount();
  const uptimeSeconds = Math.floor(process.uptime());
  const eventLoopLagMs = eventLoopHistogram
    ? Math.round(eventLoopHistogram.max / 1e6 * 100) / 100
    : null;

  let redisStatus = "unknown";
  try {
    // Simple check — if the worker is running, Redis is connected
    redisStatus = worker ? "connected" : "not_started";
  } catch {
    redisStatus = "error";
  }

  return {
    status: "ok",
    service: "voiceagent-saas",
    uptimeSeconds,
    activeCalls,
    activeBridges,
    redis: redisStatus,
    eventLoopLagMs,
    ari: getAriStatus(),
    voicenter: getVoicenterStatus(),
    mediaFormat: ASTERISK_MEDIA_FORMAT,
    liveTurnWriter: auxWorkersStarted ? "ok" : "not_started",
    agentSyncWorker: auxWorkersStarted ? "ok" : "not_started",
    janitor: auxWorkersStarted ? "ok" : "not_started",
  };
});

fastify.get("/status", async () => ({
  status: "ok",
  service: "voiceagent-saas",
  publicBaseUrl: getBaseUrl(),
  capabilities: {
    ari: getAriStatus(),
    apiKeyConfigured: Boolean(SIP_GATEWAY_API_KEY),
    eventsSecretConfigured: Boolean(SIP_GATEWAY_EVENTS_SECRET),
    voicenter: getVoicenterStatus(),
    mediaConnectionName: ASTERISK_MEDIA_CONNECTION_NAME,
    mediaFormat: ASTERISK_MEDIA_FORMAT,
    activeCallCount: callsBySipId.size,
    activeBridgeCount: getActiveBridgeCount(),
  },
}));

fastify.post("/calls", async (request, reply) => {
  const { callId, to, eventWebhookUrl, mediaStreamUrl, metadata, tenantId } = request.body || {};
  if (!callId || !to) {
    return reply.code(400).send({
      error: 'Missing "callId" or "to"',
    });
  }

  const result = await initiateCall(to, callId);
  if (!result.success) {
    return reply.code(502).send({
      error: result.error,
      sipCallId: result.sipCallId,
      status: result.status,
    });
  }

  // Store optional webhook/metadata on the call for lifecycle events
  if (eventWebhookUrl || metadata || tenantId) {
    const call = callsBySipId.get(result.sipCallId);
    if (call) {
      await markCall(call, call.status, {
        eventWebhookUrl: eventWebhookUrl || null,
        mediaStreamUrl: mediaStreamUrl || null,
        metadata: metadata || {},
        tenantId: tenantId || null,
      });
    }
  }

  return {
    success: true,
    sipCallId: result.sipCallId,
    status: result.status,
    bridgeId: result.bridgeId,
    customerChannelId: result.customerChannelId,
    mediaChannelId: result.mediaChannelId,
  };
});

fastify.get("/calls/:sipCallId", async (request, reply) => {
  const call = callsBySipId.get(String(request.params.sipCallId));
  if (!call) {
    return reply.code(404).send({ error: "Call not found" });
  }
  const { media, ...safeCall } = call;
  return { success: true, call: safeCall };
});

fastify.delete("/calls/:sipCallId", async (request, reply) => {
  const call = callsBySipId.get(String(request.params.sipCallId));
  if (!call) {
    return reply.code(404).send({ error: "Call not found" });
  }
  await gatewayState.endCall(call.sipCallId, request.body?.reason || "manual_end");
  return { success: true, sipCallId: call.sipCallId };
});

// ─── Event Loop Monitoring ────────────────────────────────────────

const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();

const eventLoopMonitorInterval = setInterval(() => {
  if (eventLoopHistogram.max > 50_000_000) { // 50ms in nanoseconds
    fastify.log.warn(
      { maxLagMs: Math.round(eventLoopHistogram.max / 1e6 * 100) / 100 },
      "Event loop lag exceeded 50ms"
    );
  }
  eventLoopHistogram.reset();
}, 10000);

// ─── BullMQ Worker Startup ────────────────────────────────────────
// The call-processor's gatewayApi.initiateCall() is wired to our
// initiateCall function above — the KEY integration point.

let worker = null;
let monthlyResetScheduler = null;
let supabaseAdmin = null;
let auxWorkersStarted = false;

// ─── Boot Ordering (LOAD-BEARING) ──────────────────────────────────
// 1. live-turn-writer BEFORE the call worker — call-bridge calls
//    enqueueTurn() as soon as a call starts; calling before init silently
//    no-ops (started guard) and we'd lose transcripts.
// 2. agent-sync worker + janitor (aux).
// 3. call worker LAST so all sinks are ready before any job dispatches.
// Note: audio archival is handled synchronously in the dashboard webhook
// handler (post_call_audio event); no worker or queue runs on the droplet.
if (REDIS_URL) {
  supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  const bullConnection = { url: REDIS_URL };

  // 1. live-turn-writer FIRST
  startLiveTurnWriter({ logger: fastify.log });
  fastify.log.info("live-turn-writer started");

  // 2. agent-sync worker
  startAgentSyncWorker({
    supabase: supabaseAdmin,
    connection: bullConnection,
    logger: fastify.log,
  });

  // 3. janitor
  startJanitor({
    supabase: supabaseAdmin,
    logger: fastify.log,
  });

  auxWorkersStarted = true;

  // 4. call worker (existing)
  worker = createCallWorker(5, {
    gatewayApi: { initiateCall, getCallState },
    log: fastify.log,
  });

  monthlyResetScheduler = createMonthlyResetScheduler();
  fastify.log.info("BullMQ call worker, agent-sync worker, janitor, and monthly reset scheduler started");
} else {
  fastify.log.warn("REDIS_URL not set — BullMQ worker disabled (gateway-only mode)");
}

// ─── Graceful Shutdown ────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  fastify.log.info({ signal }, "Shutting down...");

  // 1. Stop accepting new BullMQ jobs
  if (worker) {
    try {
      await worker.close();
      fastify.log.info("BullMQ worker stopped");
    } catch (err) {
      fastify.log.error({ err }, "Error stopping BullMQ worker");
    }
  }

  if (monthlyResetScheduler) {
    try {
      await monthlyResetScheduler.worker.close();
      await monthlyResetScheduler.queue.close();
    } catch {}
  }

  // 2. Wait up to 30s for active call bridges to finish
  const deadline = Date.now() + 30000;
  while (getActiveBridgeCount() > 0 && Date.now() < deadline) {
    fastify.log.info(
      { activeBridges: getActiveBridgeCount(), remainingMs: deadline - Date.now() },
      "Waiting for active call bridges to drain..."
    );
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 3. Force cleanup remaining bridges
  const remaining = getActiveBridgeCount();
  if (remaining > 0) {
    fastify.log.warn({ remaining }, "Force-cleaning remaining call bridges");
    cleanupAllBridges();
  }

  // ─── Aux subsystem shutdown (LOAD-BEARING, reverse of boot) ──────
  // a. agent-sync worker stops (drain in-flight jobs)
  // b. janitor timer stops (no new sweeps)
  // c. live-turn-writer LAST — must run after all bridges had a chance to
  //    flushAndClose(callId), otherwise final turns spill to disk.
  if (auxWorkersStarted) {
    try { await stopAgentSyncWorker(); } catch (err) { fastify.log.error({ err }, "stopAgentSyncWorker failed"); }
    try { await stopJanitor(); } catch (err) { fastify.log.error({ err }, "stopJanitor failed"); }
    try { await stopLiveTurnWriter(); } catch (err) { fastify.log.error({ err }, "stopLiveTurnWriter failed"); }
  }

  // 4. Stop event loop monitor
  clearInterval(eventLoopMonitorInterval);
  eventLoopHistogram.disable();

  // 5. Close Fastify (HTTP + WebSocket)
  try {
    await fastify.close();
  } catch (err) {
    fastify.log.error({ err }, "Error closing Fastify");
  }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Startup ──────────────────────────────────────────────────────

validateVoicenterConfig();
await ensureAriEventSocket(fastify.log);

fastify.listen({ port: Number(PORT), host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  fastify.log.info(
    {
      httpBaseUrl: getBaseUrl(),
      mediaConnectionName: ASTERISK_MEDIA_CONNECTION_NAME,
      ariApp: ASTERISK_ARI_APP,
      mediaFormat: ASTERISK_MEDIA_FORMAT,
      bullmqEnabled: Boolean(worker),
      activeBridgeCount: getActiveBridgeCount(),
    },
    "Voice Agent SaaS — merged gateway + voice engine ready",
  );
});
