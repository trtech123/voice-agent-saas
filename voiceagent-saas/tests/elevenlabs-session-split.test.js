// Tests for the connect() / startConversation() split in ElevenLabsSession.
// Spec: docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md §3.1
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ─── ws mock ────────────────────────────────────────────────────────
// Replace the `ws` module with a fake WebSocket that never touches the
// network. Tests emit 'open'/'message'/'close' events manually to drive
// the session through its state transitions.
class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closedWith = null;
    FakeWebSocket.last = this;
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = { code, reason };
    // emit close asynchronously like the real ws lib
    setImmediate(() => this.emit("close", code, Buffer.from(reason || "")));
  }
  // Test helpers
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }
  fireMessage(obj) {
    this.emit("message", Buffer.from(JSON.stringify(obj)));
  }
  fireError(err) {
    this.emit("error", err);
  }
}

vi.mock("ws", () => ({
  default: FakeWebSocket,
  WebSocket: FakeWebSocket,
}));

// Import AFTER the mock is set up.
const { ElevenLabsSession } = await import("../elevenlabs-session.js");

// ─── test logger ────────────────────────────────────────────────────
function makeLogger() {
  const calls = { info: [], warn: [], error: [], debug: [] };
  const log = {
    info: (...a) => calls.info.push(a),
    warn: (...a) => calls.warn.push(a),
    error: (...a) => calls.error.push(a),
    debug: (...a) => calls.debug.push(a),
    child: () => log,
  };
  log.calls = calls;
  return log;
}

describe("ElevenLabsSession connect/startConversation split", () => {
  let logger;
  beforeEach(() => {
    logger = makeLogger();
    FakeWebSocket.last = null;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("connect() opens the WS but does NOT send conversation_initiation_client_data", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: { dynamicVariables: { foo: "bar" } },
      logger,
    });

    await s.connect();
    const ws = FakeWebSocket.last;
    expect(ws).toBeDefined();

    // Fire the 'open' event — this is what the real ws lib would do
    // after the TCP/TLS/HTTP handshake completes.
    ws.fireOpen();

    // After 'open' fires, NO messages should have been sent yet.
    // In the old code, _sendInitiation() was called here.
    expect(ws.sent).toHaveLength(0);
  });

  it("connect() emits 'ws_open' when the WS handshake completes", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: {},
      logger,
    });
    let wsOpenFired = false;
    s.on("ws_open", () => {
      wsOpenFired = true;
    });

    await s.connect();
    const ws = FakeWebSocket.last;
    ws.fireOpen();

    expect(wsOpenFired).toBe(true);
  });

  it("startConversation() sends conversation_initiation_client_data", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: { dynamicVariables: { contact_name: "Tom" } },
      logger,
    });
    await s.connect();
    const ws = FakeWebSocket.last;
    ws.fireOpen();

    s.startConversation();

    expect(ws.sent).toHaveLength(1);
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe("conversation_initiation_client_data");
    expect(msg.conversation_config_override.agent.language).toBe("he");
    expect(msg.dynamic_variables.contact_name).toBe("Tom");
  });

  it("startConversation() called twice logs warn and does not double-send", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: {},
      logger,
    });
    await s.connect();
    const ws = FakeWebSocket.last;
    ws.fireOpen();

    s.startConversation();
    s.startConversation();

    expect(ws.sent).toHaveLength(1);
    const warnedTwice = logger.calls.warn.some((entry) =>
      JSON.stringify(entry).includes("startConversation called twice")
    );
    expect(warnedTwice).toBe(true);
  });

  it("startConversation() before ws_open throws with el_ws_protocol_error code", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: {},
      logger,
    });
    await s.connect();
    // Do NOT fire 'open' — WS is still handshaking.

    let caught;
    try {
      s.startConversation();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("el_ws_protocol_error");
  });

  it("sendAudio() before startConversation() silently drops frames", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: {},
      logger,
    });
    await s.connect();
    const ws = FakeWebSocket.last;
    ws.fireOpen();

    // Call sendAudio before startConversation — should be a silent no-op.
    s.sendAudio(Buffer.from(new Uint8Array(640)));
    s.sendAudio(Buffer.from(new Uint8Array(640)));

    // No messages sent, no warnings logged.
    expect(ws.sent).toHaveLength(0);
    expect(logger.calls.warn).toHaveLength(0);
  });

  it("sendAudio() after startConversation() sends user_audio_chunk", async () => {
    const s = new ElevenLabsSession({
      agentId: "agent_test",
      conversationConfig: {},
      logger,
    });
    await s.connect();
    const ws = FakeWebSocket.last;
    ws.fireOpen();
    s.startConversation();
    // Clear the initiation message so we isolate the audio frame.
    ws.sent.length = 0;

    s.sendAudio(Buffer.from(new Uint8Array(640)));

    expect(ws.sent).toHaveLength(1);
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe("user_audio_chunk");
    expect(typeof msg.user_audio_chunk).toBe("string");
  });
});
