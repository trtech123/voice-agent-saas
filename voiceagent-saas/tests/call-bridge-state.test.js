// Unit tests for the CallBridge state machine.
// Spec: docs/superpowers/specs/2026-04-08-el-session-lifecycle-fix-design.md §2 + §3.2
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// ─── Mock ElevenLabsSession ─────────────────────────────────────────
// We control connect() / startConversation() / close() / sendAudio()
// and let tests emit 'ws_open', 'error', 'closed', etc.
class MockElevenLabsSession extends EventEmitter {
  constructor() {
    super();
    this.connectCalled = false;
    this.startConversationCalls = 0;
    this.closeCalled = false;
    this.closeReason = null;
    this.sendAudioCalls = [];
  }
  async connect() {
    this.connectCalled = true;
    // The real session opens a WS and emits 'ws_open' on its own.
    // Tests drive this manually via session.emit("ws_open").
  }
  startConversation() {
    this.startConversationCalls += 1;
  }
  async close(reason) {
    this.closeCalled = true;
    this.closeReason = reason;
    this.emit("closed", { reason });
  }
  sendAudio(buf) {
    this.sendAudioCalls.push(buf);
  }
}

vi.mock("../elevenlabs-session.js", () => ({
  ElevenLabsSession: vi.fn(() => {
    const m = new MockElevenLabsSession();
    MockElevenLabsSession.last = m;
    return m;
  }),
}));

// Stub live-turn-writer so CallBridge can import it.
vi.mock("../live-turn-writer.js", () => ({
  enqueueTurn: vi.fn(),
  flushAndClose: vi.fn().mockResolvedValue(undefined),
}));

// Stub tools executor.
vi.mock("../tools.js", () => ({
  executeToolCall: vi.fn().mockResolvedValue({ ok: true }),
}));

// Import AFTER mocks are set up.
const { CallBridge } = await import("../call-bridge.js");

// ─── Test helpers ───────────────────────────────────────────────────
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

function makeSupabase(campaignRow) {
  // Minimal chainable mock for .from().select().eq().single() and .update().eq()
  const supabase = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: campaignRow, error: null }),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
      upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  };
  return supabase;
}

function makeBridge({ campaignRow, agentIdUsed = "agent_x", syncVersionUsed = 1 } = {}) {
  const log = makeLogger();
  const defaultCampaignRow = {
    id: "22222222-2222-2222-2222-222222222222",
    elevenlabs_agent_id: agentIdUsed,
    sync_version: syncVersionUsed,
    agent_status: "ready",
    voice_id: "v1",
  };
  const supabase = makeSupabase(campaignRow || defaultCampaignRow);
  const bridge = new CallBridge({
    callId: "cid-1",
    tenantId: "tid-1",
    campaignId: "22222222-2222-2222-2222-222222222222",
    contactId: "contact-1",
    campaignContactId: "cc-1",
    agentIdUsed,
    syncVersionUsed,
    campaign: { id: "22222222-2222-2222-2222-222222222222", name: "test" },
    tenant: { id: "tid-1", name: "test-tenant" },
    contact: { id: "contact-1", name: "Tom", phone: "+972501234567", custom_fields: {} },
    supabase,
    toolContext: {},
    log,
  });
  return { bridge, log, supabase };
}

describe("CallBridge state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });

  it("starts in CREATED state", () => {
    const { bridge } = makeBridge();
    expect(bridge._state).toBe("created");
  });

  it("transitions CREATED → PRE_WARMING on start()", async () => {
    const { bridge } = makeBridge();
    // start() returns a Promise that only resolves at finalize.
    // Kick off the async work but don't await resolution.
    bridge.start();
    // Give microtasks a chance to run the CAS lookup (all mocked sync).
    await new Promise((r) => setTimeout(r, 10));

    // After start() kicks off, we should be in PRE_WARMING.
    expect(bridge._state).toBe("pre_warming");
    expect(MockElevenLabsSession.last).toBeTruthy();
    expect(MockElevenLabsSession.last.connectCalled).toBe(true);
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(0);
  });

  it("transitions PRE_WARMING → PRE_WARMED when session emits ws_open", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge._state).toBe("pre_warming");

    // Simulate the real ElevenLabsSession emitting ws_open after WS handshake.
    MockElevenLabsSession.last.emit("ws_open");

    expect(bridge._state).toBe("pre_warmed");
    // Still no startConversation yet — we haven't been told the customer answered.
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(0);
  });

  it("handleCustomerAnswered() from PRE_WARMED transitions to LIVE and calls startConversation", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");
    expect(bridge._state).toBe("pre_warmed");

    bridge.handleCustomerAnswered();

    expect(bridge._state).toBe("live");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(1);
  });

  it("handleCustomerAnswered() called twice is idempotent", async () => {
    const { bridge, log } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");

    bridge.handleCustomerAnswered();
    bridge.handleCustomerAnswered();

    expect(bridge._state).toBe("live");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(1);
    expect(
      log.calls.warn.some((entry) =>
        JSON.stringify(entry).includes("handleCustomerAnswered called twice"),
      ),
    ).toBe(true);
  });

  it("handleCustomerAnswered() during PRE_WARMING queues and fires on ws_open", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge._state).toBe("pre_warming");

    // Customer answered faster than WS handshake.
    bridge.handleCustomerAnswered();
    expect(bridge._state).toBe("pre_warming"); // still pending
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(0);

    // WS finally opens.
    MockElevenLabsSession.last.emit("ws_open");

    expect(bridge._state).toBe("live");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(1);
  });

  it("handleCustomerAnswered() from FINALIZED logs warn and is a no-op", async () => {
    const { bridge, log } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");
    // Force finalize by calling the internal finalizer.
    await bridge._finalizeAndResolve("test_forced_end", null);
    expect(bridge._state).toBe("finalized");

    bridge.handleCustomerAnswered();

    // Still finalized, startConversation never called.
    expect(bridge._state).toBe("finalized");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(0);
    expect(
      log.calls.warn.some((entry) =>
        JSON.stringify(entry).includes("handleCustomerAnswered after finalize"),
      ),
    ).toBe(true);
  });

  it("handleCallerAudio drops audio in PRE_WARMING state", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge._state).toBe("pre_warming");

    bridge.handleCallerAudio(Buffer.from(new Uint8Array(640)));

    expect(MockElevenLabsSession.last.sendAudioCalls).toHaveLength(0);
  });

  it("handleCallerAudio drops audio in PRE_WARMED state (before customer answers)", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");
    expect(bridge._state).toBe("pre_warmed");

    bridge.handleCallerAudio(Buffer.from(new Uint8Array(640)));

    expect(MockElevenLabsSession.last.sendAudioCalls).toHaveLength(0);
  });

  it("handleCallerAudio forwards audio in LIVE state", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");
    bridge.handleCustomerAnswered();
    expect(bridge._state).toBe("live");

    bridge.handleCallerAudio(Buffer.from(new Uint8Array(640)));

    expect(MockElevenLabsSession.last.sendAudioCalls).toHaveLength(1);
  });
});
