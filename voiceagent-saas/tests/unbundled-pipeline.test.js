// voiceagent-saas/tests/unbundled-pipeline.test.js
// Integration tests for the UnbundledPipeline orchestrator.
// All externals (Deepgram, OpenAI, ElevenLabs) are mocked. Drives the
// pipeline through realistic call scenarios end-to-end.
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §5.4, §8.1

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ─── Mock all 3 external sessions ────────────────────────────────────────

let lastDg = null;
let lastTts = null;
let lastLlm = null;

// Track ALL TTS instances (greeting + turn) for multi-TTS tests
let allTtsInstances = [];

class MockDeepgram extends EventEmitter {
  constructor() {
    super();
    lastDg = this;
    this.connectCalled = false;
    this.audioChunks = [];
    this.closed = false;
  }
  async connect() { this.connectCalled = true; }
  sendAudio(buf) { this.audioChunks.push(buf); }
  finish() {}
  close() { this.closed = true; this.emit("closed", { reason: "test" }); }
}

class MockTts extends EventEmitter {
  constructor() {
    super();
    lastTts = this;
    allTtsInstances.push(this);
    this.started = false;
    this.sentences = [];
    this.finished = false;
    this.stopped = false;
  }
  async start() { this.started = true; }
  pushSentence(text) { this.sentences.push(text); }
  finish() {
    this.finished = true;
    // Auto-emit done after a microtask so the pipeline transitions to LISTENING
    Promise.resolve().then(() => this.emit("done", { totalChars: 0 }));
  }
  stop() { this.stopped = true; this.emit("stopped"); }
}

// MockLlm uses a callback-based script injection so the test can set the
// script BEFORE run() is called by the pipeline.
let nextLlmScript = null;

class MockLlm {
  constructor(opts) {
    lastLlm = this;
    this.opts = opts;
    this._toolResolvers = new Map();
    this._scriptedYields = nextLlmScript || [];
    nextLlmScript = null; // consumed
  }
  async *run(messages) {
    this._lastMessages = messages;
    for (const ev of this._scriptedYields) {
      if (ev.type === "tool_call_request") {
        // Pre-register the resolver BEFORE yielding so provideToolResult
        // can resolve it even though the generator is still paused at yield.
        const p = new Promise((r) => this._toolResolvers.set(ev.callId, r));
        yield ev;
        await p;
      } else {
        yield ev;
      }
    }
  }
  provideToolResult(callId, result) {
    const r = this._toolResolvers.get(callId);
    if (r) { this._toolResolvers.delete(callId); r(result); }
  }
}

vi.mock("../deepgram-session.js", () => ({ DeepgramSession: MockDeepgram }));
vi.mock("../tts-session.js", () => ({ TTSSession: MockTts, TTSSessionError: class extends Error {} }));
vi.mock("../llm-session.js", () => ({ LLMSession: MockLlm, LLMSessionError: class extends Error {}, getOpenAIAgent: () => null, __setFetchForTests: () => {} }));
vi.mock("../tools.js", () => ({
  buildOpenAIToolSchema: () => [],
  buildToolDefinitions: () => [],
  executeToolCall: vi.fn(async (name, args) => ({ ok: true, name, args })),
}));

// Mock global fetch for the boot synthesis path so it doesn't hit the network
const origFetch = global.fetch;
global.fetch = vi.fn(async () => ({
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(640),
}));

const { UnbundledPipeline } = await import("../unbundled-pipeline.js");
const { executeToolCall } = await import("../tools.js");

function makeLogger() {
  return {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    child: function () { return this; },
  };
}

function makePipeline(overrides = {}) {
  return new UnbundledPipeline({
    tenantId: "t1",
    callId: "c1",
    campaign: {
      id: "camp1",
      system_prompt: "אתה דני. {{contact_name}}",
      first_message: "שלום {{contact_name}}!",
    },
    contact: { name: "תום", custom_fields: {} },
    tenant: { name: "test-co" },
    apiKeys: { deepgram: "k", openai: "k", elevenlabs: "k" },
    logger: makeLogger(),
    toolContext: {},
    ...overrides,
  });
}

// Helper: connect + startConversation, wait for greeting TTS done → LISTENING
async function connectAndGreet(p) {
  await p.connect();
  await p.startConversation();
  // Wait for the TTS done microtask to fire (transitions to LISTENING)
  await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  lastDg = lastTts = lastLlm = null;
  allTtsInstances = [];
  nextLlmScript = null;
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore fetch just in case
  global.fetch = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(640),
  }));
});

// ─── Test scenarios ──────────────────────────────────────────────────────

describe("UnbundledPipeline — happy path", () => {
  it("connects, greets, and emits agent_response with the interpolated first message", async () => {
    const p = makePipeline();
    const events = [];
    p.on("ws_open", () => events.push("ws_open"));
    p.on("conversation_id", (id) => events.push(["conversation_id", id]));
    p.on("agent_response", (e) => events.push(["agent_response", e.text]));

    await p.connect();
    await p.startConversation();

    expect(events[0]).toBe("ws_open");
    expect(events[1][0]).toBe("conversation_id");
    expect(events[2]).toEqual(["agent_response", "שלום תום!"]);
    expect(lastTts.sentences).toEqual(["שלום תום!"]);
  });

  it("commitUserTurn appends to history and runs the LLM", async () => {
    const p = makePipeline();
    await connectAndGreet(p);

    // Set the LLM script BEFORE calling commitUserTurn
    nextLlmScript = [
      { type: "sentence", text: "מעולה." },
      { type: "usage", tokens_in: 100, tokens_out: 5 },
      { type: "done", fullText: "מעולה.", totalTokensIn: 100, totalTokensOut: 5 },
    ];

    p._latestPartialText = "כן יש לי עסק";
    const agentResponses = [];
    p.on("agent_response", (e) => agentResponses.push(e.text));

    await p.commitUserTurn("our_vad");
    // Wait for TTS done microtask
    await new Promise((r) => setTimeout(r, 10));

    expect(p._messages.find((m) => m.role === "user")?.content).toBe("כן יש לי עסק");
    expect(agentResponses).toContain("מעולה.");
    expect(p.metrics.llmTokensIn).toBe(100);
    expect(p.metrics.llmTokensOut).toBe(5);
  });
});

describe("UnbundledPipeline — tool call", () => {
  it("executes a tool call and resumes the LLM", async () => {
    const p = makePipeline();
    await connectAndGreet(p);

    const toolCallId = "tc-1";
    nextLlmScript = [
      { type: "tool_call_request", name: "score_lead", args: { score: 80 }, callId: toolCallId },
      { type: "sentence", text: "סיימתי." },
      { type: "done", fullText: "סיימתי." },
    ];

    p._latestPartialText = "תן לי ציון";

    const toolEvents = [];
    p.on("tool_call", (e) => toolEvents.push(e));

    await p.commitUserTurn("our_vad");
    await new Promise((r) => setTimeout(r, 10));

    expect(executeToolCall).toHaveBeenCalledWith("score_lead", { score: 80 }, {});
    expect(toolEvents.length).toBe(1);
    expect(toolEvents[0].name).toBe("score_lead");
    expect(p.metrics.toolCallCount).toBe(1);
  });
});

describe("UnbundledPipeline — filler audio", () => {
  it("plays filler audio when tool takes longer than FILLER_DELAY_MS", async () => {
    const p = makePipeline();
    await connectAndGreet(p);

    // Make the tool call take longer than 500ms
    executeToolCall.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 700));
      return { ok: true };
    });

    const toolCallId = "tc-filler";
    nextLlmScript = [
      { type: "tool_call_request", name: "send_whatsapp", args: {}, callId: toolCallId },
      { type: "sentence", text: "שלחתי." },
      { type: "done", fullText: "שלחתי." },
    ];

    p._latestPartialText = "שלח וואטסאפ";
    const audioEvents = [];
    p.on("agent_audio", (buf) => audioEvents.push(buf));

    await p.commitUserTurn("our_vad");
    await new Promise((r) => setTimeout(r, 10));

    // The filler audio should have fired (we check that agent_audio was emitted
    // during the tool call phase)
    expect(audioEvents.length).toBeGreaterThan(0);
  });
});

describe("UnbundledPipeline — barge-in", () => {
  it("aborts LLM + stops TTS + emits interruption on barge", async () => {
    const p = makePipeline();
    await connectAndGreet(p);

    // Manually put the pipeline into SPEAKING state with mock adapters
    p._setState("speaking");
    p._lastTtsAudioAt = Date.now() - 300; // well past the barge gate
    p._currentLlmAbort = new AbortController();
    const mockTts = new MockTts();
    p._currentTts = mockTts;

    const interruptions = [];
    p.on("interruption", (e) => interruptions.push(e));

    p._evaluateBargeGate({ text: "אני רוצה", ts: Date.now() });

    expect(p._state).toBe("listening");
    expect(interruptions.length).toBe(1);
    expect(p.metrics.bargeCount).toBe(1);
    expect(mockTts.stopped).toBe(true);
  });
});

describe("UnbundledPipeline — barge gate blocks", () => {
  it("blocks barge when text is too short", async () => {
    const p = makePipeline();
    await connectAndGreet(p);
    p._setState("speaking");
    p._lastTtsAudioAt = Date.now() - 300;

    const interruptions = [];
    p.on("interruption", (e) => interruptions.push(e));

    p._evaluateBargeGate({ text: "כ", ts: Date.now() }); // 1 char < 3 min

    expect(interruptions.length).toBe(0);
    expect(p._state).toBe("speaking"); // unchanged
  });

  it("blocks barge when within echo tail", async () => {
    const p = makePipeline();
    await connectAndGreet(p);
    p._setState("speaking");
    p._lastTtsAudioAt = Date.now() - 10; // only 10ms ago, within 150ms gate

    const interruptions = [];
    p.on("interruption", (e) => interruptions.push(e));

    p._evaluateBargeGate({ text: "אני רוצה לדבר", ts: Date.now() });

    expect(interruptions.length).toBe(0);
    expect(p._state).toBe("speaking");
  });
});

describe("UnbundledPipeline — barge loop", () => {
  it("ends call after too many barges in window", async () => {
    const p = makePipeline();
    await connectAndGreet(p);

    const errors = [];
    p.on("error", (e) => errors.push(e));

    // Simulate 6 barges (threshold is 5)
    for (let i = 0; i < 6; i++) {
      p._setState("speaking");
      p._lastTtsAudioAt = Date.now() - 300;
      p._evaluateBargeGate({ text: "אני רוצה", ts: Date.now() });
    }

    // The 6th barge should trigger the loop detector
    const loopError = errors.find((e) => e.code === "barge_loop_detected");
    expect(loopError).toBeDefined();
  });
});

describe("UnbundledPipeline — sliding window", () => {
  it("trims history to last 20 turn pairs plus system", async () => {
    const p = makePipeline();
    await connectAndGreet(p);

    // Manually add 25 user/assistant pairs beyond the initial system + assistant
    for (let i = 0; i < 25; i++) {
      p._messages.push({ role: "user", content: `user-${i}` });
      p._messages.push({ role: "assistant", content: `assistant-${i}` });
    }
    // Plus the system and initial assistant = 2 + 50 = 52 messages
    // Call sliding window
    p._applySlidingWindow();

    // System should still be first
    expect(p._messages[0].role).toBe("system");
    // Non-system messages should be capped at 40 (20 pairs)
    const nonSystem = p._messages.filter((m) => m.role !== "system");
    expect(nonSystem.length).toBe(40);
    // Latest pair should be user-24/assistant-24
    expect(nonSystem[nonSystem.length - 1].content).toBe("assistant-24");
  });
});

describe("UnbundledPipeline — LLM round budget", () => {
  it("ends call when round budget is exhausted", async () => {
    const p = makePipeline();
    await connectAndGreet(p);

    // Set round count to the max
    p._roundCountThisCall = 50; // LLM_MAX_ROUNDS_PER_CALL default

    p._latestPartialText = "עוד שאלה";

    const errors = [];
    p.on("error", (e) => errors.push(e));

    await p.commitUserTurn("our_vad");
    // Wait for error + close
    await new Promise((r) => setTimeout(r, 300));

    const budgetError = errors.find((e) => e.code === "llm_round_budget_exhausted");
    expect(budgetError).toBeDefined();
  });
});

describe("UnbundledPipeline — STT failures", () => {
  it("emits stt_init_failed when Deepgram connect fails", async () => {
    // Temporarily override MockDeepgram.connect to throw
    const origConnect = MockDeepgram.prototype.connect;
    MockDeepgram.prototype.connect = async function () {
      throw new Error("ws connection refused");
    };

    const p = makePipeline();
    const errors = [];
    p.on("error", (e) => errors.push(e));

    await p.connect().catch(() => {});

    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe("stt_init_failed");

    MockDeepgram.prototype.connect = origConnect;
  });

  it("emits stt_dropped and closes on mid-call Deepgram error", async () => {
    const p = makePipeline();
    const errors = [];
    p.on("error", (e) => errors.push(e));

    await p.connect();

    // Simulate Deepgram emitting an error mid-call
    lastDg.emit("error", { message: "ws dropped", code: "ws_close_unexpected" });

    await new Promise((r) => setTimeout(r, 10));

    expect(errors.some((e) => e.code === "stt_dropped")).toBe(true);
    expect(p._state).toBe("closed");
  });
});

describe("UnbundledPipeline — TTS init failure", () => {
  it("emits tts_init_failed and closes when greeting TTS start() fails", async () => {
    const origStart = MockTts.prototype.start;
    MockTts.prototype.start = async function () {
      throw new Error("ws connect timeout");
    };

    const p = makePipeline();
    const errors = [];
    p.on("error", (e) => errors.push(e));

    await p.connect();
    await p.startConversation();
    await new Promise((r) => setTimeout(r, 10));

    expect(errors.some((e) => e.code === "tts_init_failed")).toBe(true);
    expect(p._state).toBe("closed");

    MockTts.prototype.start = origStart;
  });
});

describe("UnbundledPipeline — close during tool", () => {
  it("waits for in-flight tool then closes", async () => {
    const p = makePipeline();
    await connectAndGreet(p);

    // Simulate an in-flight tool by setting _currentToolPromise directly
    let toolResolve;
    p._currentToolPromise = new Promise((r) => { toolResolve = r; });

    // Close while tool is in-flight — should wait up to 5s
    const closePromise = p.close("hangup");

    // Resolve the tool after a short delay
    setTimeout(() => {
      toolResolve({ ok: true });
      p._currentToolPromise = null;
    }, 50);

    await closePromise;

    expect(p._state).toBe("closed");
    expect(p._closed).toBe(true);
  });
});
