import "dotenv/config";
import WebSocket from "ws";

const {
  ASTERISK_ARI_BASE_URL,
  ASTERISK_ARI_USERNAME,
  ASTERISK_ARI_PASSWORD,
  ASTERISK_ARI_APP = "voiceagent-saas-media",
} = process.env;

let ariSocket = null;
let reconnectTimer = null;
let connected = false;
const listeners = new Set();

function baseUrl() {
  return String(ASTERISK_ARI_BASE_URL || "").replace(/\/+$/, "");
}

function credentials() {
  return {
    username: ASTERISK_ARI_USERNAME,
    password: ASTERISK_ARI_PASSWORD,
  };
}

function authHeader() {
  const { username, password } = credentials();
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return `Basic ${token}`;
}

function requireConfig() {
  if (!ASTERISK_ARI_BASE_URL || !ASTERISK_ARI_USERNAME || !ASTERISK_ARI_PASSWORD) {
    throw new Error("Asterisk ARI is not configured");
  }
}

function buildUrl(pathname, query = {}) {
  requireConfig();
  const url = new URL(`${baseUrl()}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

export function getAriStatus() {
  return {
    configured: Boolean(ASTERISK_ARI_BASE_URL && ASTERISK_ARI_USERNAME && ASTERISK_ARI_PASSWORD),
    connected,
    baseUrlConfigured: Boolean(ASTERISK_ARI_BASE_URL),
    usernameConfigured: Boolean(ASTERISK_ARI_USERNAME),
    passwordConfigured: Boolean(ASTERISK_ARI_PASSWORD),
    app: ASTERISK_ARI_APP,
  };
}

export async function ariRequest(method, pathname, { query, body } = {}) {
  const response = await fetch(buildUrl(pathname, query), {
    method,
    headers: {
      Authorization: authHeader(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `ARI request failed (${response.status})`);
  }

  return payload;
}

export async function ensureAriEventSocket(logger) {
  if (ariSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ariSocket.readyState)) {
    return;
  }

  requireConfig();
  const wsUrl = buildUrl("/events", {
    app: ASTERISK_ARI_APP,
    subscribeAll: "true",
    api_key: `${ASTERISK_ARI_USERNAME}:${ASTERISK_ARI_PASSWORD}`,
  })
    .toString()
    .replace(/^http/i, "ws");

  ariSocket = new WebSocket(wsUrl);

  ariSocket.on("open", () => {
    connected = true;
    logger.info({ app: ASTERISK_ARI_APP }, "Connected to Asterisk ARI events");
  });

  ariSocket.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      for (const listener of listeners) {
        listener(payload);
      }
    } catch (error) {
      logger.error({ error }, "Failed to parse ARI event payload");
    }
  });

  ariSocket.on("error", (error) => {
    logger.error({ error }, "Asterisk ARI websocket error");
  });

  ariSocket.on("close", () => {
    connected = false;
    logger.warn("Asterisk ARI websocket closed; scheduling reconnect");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      ensureAriEventSocket(logger).catch((error) => {
        logger.error({ error }, "Failed to reconnect to Asterisk ARI websocket");
      });
    }, 3000);
  });
}

export function subscribeToAriEvents(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
