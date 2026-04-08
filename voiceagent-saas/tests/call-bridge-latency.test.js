// voiceagent-saas/tests/call-bridge-latency.test.js
// Unit tests for CallBridge latency instrumentation.
// Spec: docs/superpowers/specs/2026-04-08-call-latency-instrumentation-design.md
// Plan: docs/superpowers/plans/2026-04-08-call-latency-instrumentation-plan.md
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

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

vi.mock("../live-turn-writer.js", () => ({
  enqueueTurn: vi.fn(),
  flushAndClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../tools.js", () => ({
  executeToolCall: vi.fn().mockResolvedValue({ ok: true }),
}));

const { CallBridge } = await import("../call-bridge.js");

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
  const upsertCalls = [];
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
      upsert: vi.fn((row, opts) => {
        upsertCalls.push({ row, opts });
        return Promise.resolve({ data: null, error: null });
      }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  };
  supabase._upsertCalls = upsertCalls;
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

// Helper: advance the bridge to LIVE state via the happy-path choreography.
async function driveToLive(bridge) {
  bridge.start();
  await new Promise((r) => setTimeout(r, 10));
  MockElevenLabsSession.last.emit("ws_open");
  bridge.handleCustomerAnswered();
}

describe("CallBridge latency — harness sanity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });

  it("can construct a bridge and drive it to LIVE", async () => {
    const { bridge } = makeBridge();
    await driveToLive(bridge);
    expect(bridge._state).toBe("live");
    expect(MockElevenLabsSession.last.startConversationCalls).toBe(1);
  });
});

// Re-import helpers. We expose them on the module for testability.
const callBridgeModule = await import("../call-bridge.js");
const { clampNonNegative, mean, percentile } = callBridgeModule;

describe("latency helpers", () => {
  describe("clampNonNegative", () => {
    it("returns the number when positive", () => {
      expect(clampNonNegative(42)).toBe(42);
    });
    it("returns the number when zero", () => {
      expect(clampNonNegative(0)).toBe(0);
    });
    it("returns 0 when negative (clock went backward)", () => {
      expect(clampNonNegative(-5)).toBe(0);
    });
    it("returns 0 for non-numbers", () => {
      expect(clampNonNegative(null)).toBe(0);
      expect(clampNonNegative(undefined)).toBe(0);
      expect(clampNonNegative("5")).toBe(0);
    });
  });

  describe("mean", () => {
    it("returns null on empty", () => {
      expect(mean([])).toBe(null);
    });
    it("returns null on null/undefined", () => {
      expect(mean(null)).toBe(null);
      expect(mean(undefined)).toBe(null);
    });
    it("returns the single value on n=1", () => {
      expect(mean([7])).toBe(7);
    });
    it("computes arithmetic mean", () => {
      expect(mean([1, 2, 3, 4, 5])).toBe(3);
    });
  });

  describe("percentile", () => {
    it("returns null on empty", () => {
      expect(percentile([], 0.95)).toBe(null);
    });
    it("returns the single value on n=1", () => {
      expect(percentile([100], 0.95)).toBe(100);
    });
    it("degenerates to max at small n (n=2, p=0.95) — locked behavior", () => {
      // floor(0.95 * 2) = 1 → sorted[1] = max. Do NOT "fix" this.
      expect(percentile([10, 20], 0.95)).toBe(20);
    });
    it("n=5: floor(4.75)=4 → max", () => {
      expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    });
    it("n=20: floor(19)=19 → max", () => {
      const arr = Array.from({ length: 20 }, (_, i) => i + 1);
      expect(percentile(arr, 0.95)).toBe(20);
    });
    it("is order-independent (sorts internally)", () => {
      expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
    });
  });
});

describe("customerAnsweredAt stamping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });

  it("stamps customerAnsweredAt on handleCustomerAnswered() from PRE_WARMED", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");
    expect(bridge.latency.customerAnsweredAt).toBe(null);

    const before = Date.now();
    bridge.handleCustomerAnswered();
    const after = Date.now();

    expect(bridge.latency.customerAnsweredAt).toBeGreaterThanOrEqual(before);
    expect(bridge.latency.customerAnsweredAt).toBeLessThanOrEqual(after);
  });

  it("stamps customerAnsweredAt when called during PRE_WARMING (queued race)", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge._state).toBe("pre_warming");
    expect(bridge.latency.customerAnsweredAt).toBe(null);

    // Customer answered before ws_open.
    bridge.handleCustomerAnswered();
    expect(bridge.latency.customerAnsweredAt).not.toBe(null);
    // State is still pre_warming (queued).
    expect(bridge._state).toBe("pre_warming");

    // Subsequent ws_open drains the queue into LIVE.
    MockElevenLabsSession.last.emit("ws_open");
    expect(bridge._state).toBe("live");
  });

  it("does not re-stamp customerAnsweredAt on a second call", async () => {
    const { bridge } = makeBridge();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");

    bridge.handleCustomerAnswered();
    const first = bridge.latency.customerAnsweredAt;
    await new Promise((r) => setTimeout(r, 5));
    bridge.handleCustomerAnswered(); // second call — idempotent, should warn

    expect(bridge.latency.customerAnsweredAt).toBe(first);
  });
});

describe("greeting_latency_ms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });

  // Helper: a tiny PCM16 buffer. Content doesn't matter for these tests.
  const audioChunk = () => Buffer.alloc(320);

  it("computes greeting_latency_ms on first agent_audio after customer_answered", async () => {
    const { bridge } = makeBridge();
    // Install a fake sendToAsterisk so the hot path runs without throwing.
    bridge.sendToAsterisk = vi.fn();

    await driveToLive(bridge);
    // Wait ~20ms, then emit the first agent_audio.
    await new Promise((r) => setTimeout(r, 20));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.greetingLatencyMs).not.toBe(null);
    expect(bridge.latency.greetingLatencyMs).toBeGreaterThanOrEqual(15);
    expect(bridge.latency.greetingLatencyMs).toBeLessThan(500);
  });

  it("only computes greeting_latency_ms once (second chunk is a no-op for greeting)", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    await new Promise((r) => setTimeout(r, 10));

    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    const first = bridge.latency.greetingLatencyMs;
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.greetingLatencyMs).toBe(first);
  });

  it("greeting_latency_ms stays null if customer never answered", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    bridge.start();
    await new Promise((r) => setTimeout(r, 10));
    MockElevenLabsSession.last.emit("ws_open");
    // Never call handleCustomerAnswered.
    // Simulate a rogue agent_audio arriving anyway (defensive path).
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.greetingLatencyMs).toBe(null);
  });

  it("sendToAsterisk is called BEFORE greeting latency is computed (hot path first)", async () => {
    const { bridge } = makeBridge();
    const order = [];
    bridge.sendToAsterisk = vi.fn(() => order.push("send"));
    // Monkey-patch _recordAgentAudioLatency after construction to observe ordering.
    const origRecord = bridge._recordAgentAudioLatency.bind(bridge);
    bridge._recordAgentAudioLatency = (receivedAt, sentAt) => {
      order.push("record");
      return origRecord(receivedAt, sentAt);
    };

    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(order).toEqual(["send", "record"]);
  });

  it("audio_plumbing sample is recorded for the greeting first chunk", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.audioPlumbingSamplesMs.length).toBe(1);
    expect(bridge.latency.audioPlumbingSamplesMs[0]).toBeGreaterThanOrEqual(0);
  });
});

describe("turn_latency_ms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });
  const audioChunk = () => Buffer.alloc(320);

  it("user_transcript isFinal=true updates lastPartialTranscriptAt", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);

    const before = Date.now();
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "שלום",
      isFinal: true,
      ts: Date.now(),
    });
    const after = Date.now();

    expect(bridge.latency.lastPartialTranscriptAt).toBeGreaterThanOrEqual(before);
    expect(bridge.latency.lastPartialTranscriptAt).toBeLessThanOrEqual(after);
  });

  it("user_transcript isFinal=false ALSO updates lastPartialTranscriptAt (no gating)", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);

    const before = Date.now();
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "שלו...",
      isFinal: false,
      ts: Date.now(),
    });
    const after = Date.now();

    expect(bridge.latency.lastPartialTranscriptAt).toBeGreaterThanOrEqual(before);
    expect(bridge.latency.lastPartialTranscriptAt).toBeLessThanOrEqual(after);
  });

  it("multiple user_transcript events → lastPartialTranscriptAt is the most recent", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);

    MockElevenLabsSession.last.emit("user_transcript", {
      text: "first",
      isFinal: false,
      ts: Date.now(),
    });
    const firstAt = bridge.latency.lastPartialTranscriptAt;

    await new Promise((r) => setTimeout(r, 15));
    MockElevenLabsSession.last.emit("user_transcript", {
      text: "second",
      isFinal: true,
      ts: Date.now(),
    });
    const secondAt = bridge.latency.lastPartialTranscriptAt;

    expect(secondAt).toBeGreaterThan(firstAt);
  });

  it("subsequent agent_audio chunks in the same turn do NOT create extra samples", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    MockElevenLabsSession.last.emit("user_transcript", {
      text: "test",
      isFinal: true,
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 10));

    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());

    expect(bridge.latency.turnLatenciesMs.length).toBe(1);
    // audio_plumbing samples: 1 from greeting + 1 from turn first chunk = 2
    expect(bridge.latency.audioPlumbingSamplesMs.length).toBe(2);
  });
});

describe("barge-in handling (interruption event)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });
  const audioChunk = () => Buffer.alloc(320);

  it("interruption with lastPartialTranscriptAt set → flag is raised", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", Buffer.alloc(320)); // greeting

    MockElevenLabsSession.last.emit("user_transcript", {
      text: "test",
      isFinal: false,
      ts: Date.now(),
    });
    expect(bridge.latency.lastPartialTranscriptAt).not.toBe(null);

    MockElevenLabsSession.last.emit("interruption", {});
    expect(bridge.latency.pendingUserFinalIsBarge).toBe(true);
  });

  it("interruption with no anchors → no-op", async () => {
    const { bridge } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", Buffer.alloc(320)); // greeting

    // No user_transcript and no VAD activity yet (no inbound audio).
    MockElevenLabsSession.last.emit("interruption", {});
    expect(bridge.latency.pendingUserFinalIsBarge).toBe(false);
  });
});

describe("_persistFinalState latency aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockElevenLabsSession.last = null;
  });
  const audioChunk = () => Buffer.alloc(320);

  // Extract the call_metrics upsert row from the recorded calls.
  function findCallMetricsUpsert(supabase) {
    return supabase._upsertCalls.find(
      (c) => c.row && c.row.call_id && c.row.tenant_id,
    );
  }

  it("persists latency fields with turns present", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting

    for (let i = 0; i < 3; i++) {
      MockElevenLabsSession.last.emit("user_transcript", {
        text: `t${i}`,
        isFinal: true,
        ts: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 10));
      MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    }

    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    const upsert = findCallMetricsUpsert(supabase);
    expect(upsert).toBeTruthy();
    expect(upsert.row.greeting_latency_ms).not.toBe(null);
    expect(upsert.row.greeting_latency_ms).toBeGreaterThanOrEqual(0);
    expect(upsert.row.avg_turn_latency_ms).not.toBe(null);
    expect(upsert.row.p95_turn_latency_ms).not.toBe(null);
    expect(upsert.row.audio_plumbing_ms).not.toBe(null);
    expect(upsert.row.turn_latencies_ms).toHaveLength(3);
  });

  it("persists NULLs when no turns happened", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk()); // greeting only

    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    const upsert = findCallMetricsUpsert(supabase);
    expect(upsert.row.greeting_latency_ms).not.toBe(null);
    expect(upsert.row.avg_turn_latency_ms).toBe(null);
    expect(upsert.row.p95_turn_latency_ms).toBe(null);
    expect(upsert.row.turn_latencies_ms).toBe(null);
  });

  it("bridge upsert uses ignoreDuplicates: false (last-writer-wins)", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    MockElevenLabsSession.last.emit("agent_audio", audioChunk());
    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    const upsert = findCallMetricsUpsert(supabase);
    expect(upsert.opts).toEqual({
      onConflict: "call_id",
      ignoreDuplicates: false,
    });
  });

  it("aggregation failure is caught and does not break the upsert", async () => {
    const { bridge, supabase } = makeBridge();
    bridge.sendToAsterisk = vi.fn();
    await driveToLive(bridge);
    // Poison the tracker to force a throw during aggregation.
    bridge.latency.turnLatenciesMs = {
      get length() {
        throw new Error("boom");
      },
    };

    bridge.endBridge("test_done");
    await new Promise((r) => setTimeout(r, 20));

    // call_metrics upsert should STILL happen with the non-latency fields.
    const upsert = findCallMetricsUpsert(supabase);
    expect(upsert).toBeTruthy();
    expect(upsert.row.call_id).toBe("cid-1");
  });
});

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("janitor upsert behavior lock (spec §4.6)", () => {
  it("janitor.js call_metrics upsert uses ignoreDuplicates: true", () => {
    const janitorPath = resolve(__dirname, "../janitor.js");
    const src = readFileSync(janitorPath, "utf8");
    // Find the call_metrics upsert options literal and assert it contains
    // ignoreDuplicates: true. If someone flips this, the test fails loudly.
    const metricsUpsertIdx = src.indexOf('from("call_metrics")');
    expect(metricsUpsertIdx).toBeGreaterThan(-1);
    // Look at the ~500 chars following the from() call.
    const slice = src.slice(metricsUpsertIdx, metricsUpsertIdx + 500);
    expect(slice).toContain("ignoreDuplicates: true");
    expect(slice).not.toContain("ignoreDuplicates: false");
  });
});
