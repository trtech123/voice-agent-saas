// voiceagent-saas/tests/llm-session.test.js
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §5.2
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as llmModule from "../llm-session.js";
import { LLMSession, __setFetchForTests } from "../llm-session.js";
import * as fixtures from "./fixtures/openai-sse-fixtures.js";

function makeLogger() {
  const calls = { info: [], warn: [], error: [], debug: [] };
  return {
    info: (...a) => calls.info.push(a),
    warn: (...a) => calls.warn.push(a),
    error: (...a) => calls.error.push(a),
    debug: (...a) => calls.debug.push(a),
    child: function () { return this; },
    calls,
  };
}

// Wrap an SSE string into a fetch Response with a streaming body.
function fetchResponseFromSse(sseText, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  // Stream in chunks of ~30 bytes to simulate network fragmentation.
  const chunks = [];
  for (let i = 0; i < sseText.length; i += 30) {
    chunks.push(encoder.encode(sseText.slice(i, i + 30)));
  }
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { status, headers });
}

// We will write tests against the public LLMSession API by mocking _fetch.
// Sentence detection is exercised via the run() generator.

describe("LLMSession — sentence boundary detection (via run)", () => {
  beforeEach(() => {
    __setFetchForTests(null);
  });

  it("emits one 'sentence' event for a single Hebrew sentence", async () => {
    __setFetchForTests(async () => fetchResponseFromSse(fixtures.SIMPLE_HEBREW));
    const s = new LLMSession({ apiKey: "k", logger: makeLogger() });
    const yielded = [];
    for await (const ev of s.run([{ role: "user", content: "hi" }])) {
      yielded.push(ev);
    }
    const sentences = yielded.filter((e) => e.type === "sentence");
    expect(sentences.length).toBe(1);
    expect(sentences[0].text).toContain("שלום");
    expect(sentences[0].text).toContain("לעזור לך?");
  });

  it("emits three 'sentence' events for a three-sentence response", async () => {
    __setFetchForTests(async () => fetchResponseFromSse(fixtures.TWO_SENTENCES));
    const s = new LLMSession({ apiKey: "k", logger: makeLogger() });
    const yielded = [];
    for await (const ev of s.run([{ role: "user", content: "hi" }])) {
      yielded.push(ev);
    }
    const sentences = yielded.filter((e) => e.type === "sentence");
    // Fixture has 3 sentence boundaries: "סבבה.", "פעיל?", "שלנו."
    expect(sentences.length).toBe(3);
    expect(sentences[0].text).toMatch(/אה, סבבה\./);
    expect(sentences[1].text).toMatch(/יש לך עסק פעיל\?/);
    expect(sentences[2].text).toMatch(/לחברה שלנו\./);
  });

  it("first sentence flushes immediately even if shorter than 4 words", async () => {
    __setFetchForTests(async () => fetchResponseFromSse(fixtures.SHORT_FIRST_SENTENCE));
    const s = new LLMSession({ apiKey: "k", logger: makeLogger() });
    const yielded = [];
    for await (const ev of s.run([{ role: "user", content: "hi" }])) {
      yielded.push(ev);
    }
    const sentences = yielded.filter((e) => e.type === "sentence");
    // First sentence "מעולה." is 1 word — it MUST still flush as the first sentence.
    expect(sentences.length).toBe(2);
    expect(sentences[0].text).toMatch(/^מעולה/);
  });

  it("flushes a final sentence with no trailing whitespace via max-buffer-ms timer", async () => {
    __setFetchForTests(async () => fetchResponseFromSse(fixtures.NO_TRAILING_WS));
    const s = new LLMSession({ apiKey: "k", logger: makeLogger() });
    const yielded = [];
    for await (const ev of s.run([{ role: "user", content: "hi" }])) {
      yielded.push(ev);
    }
    const sentences = yielded.filter((e) => e.type === "sentence");
    expect(sentences.length).toBe(1);
    expect(sentences[0].text).toBe("שלום.");
  });

  it("emits 'done' with totalTokensIn / totalTokensOut from usage event", async () => {
    __setFetchForTests(async () => fetchResponseFromSse(fixtures.SIMPLE_HEBREW));
    const s = new LLMSession({ apiKey: "k", logger: makeLogger() });
    const yielded = [];
    for await (const ev of s.run([{ role: "user", content: "hi" }])) {
      yielded.push(ev);
    }
    const done = yielded.find((e) => e.type === "done");
    expect(done).toBeTruthy();
    expect(done.totalTokensIn).toBe(120);
    expect(done.totalTokensOut).toBe(8);
  });
});

describe("LLMSession — tool calls", () => {
  beforeEach(() => {
    __setFetchForTests(null);
  });

  it("yields a tool_call_request when the model emits a tool_calls delta", async () => {
    let callCount = 0;
    __setFetchForTests(async () => {
      callCount++;
      if (callCount === 1) return fetchResponseFromSse(fixtures.TOOL_CALL_SPLIT_ARGS);
      // Second call (after tool result) returns a normal sentence
      return fetchResponseFromSse(fixtures.SIMPLE_HEBREW);
    });

    const s = new LLMSession({ apiKey: "k", logger: makeLogger(), toolSchema: [{ type: "function", function: { name: "score_lead", description: "x", parameters: { type: "object", properties: {} } } }] });
    const yielded = [];
    const gen = s.run([{ role: "user", content: "hi" }]);
    for await (const ev of gen) {
      yielded.push(ev);
      if (ev.type === "tool_call_request") {
        // Resolve the tool result so the loop can proceed.
        s.provideToolResult(ev.callId, JSON.stringify({ ok: true }));
      }
    }
    const tc = yielded.find((e) => e.type === "tool_call_request");
    expect(tc).toBeTruthy();
    expect(tc.name).toBe("score_lead");
    expect(tc.args).toEqual({ score: 8, reason: "מתעניין בבירור" });
    expect(tc.callId).toBe("call_abc");
  });

  it("yields tool_call_request for each parallel tool call in one round", async () => {
    let callCount = 0;
    __setFetchForTests(async () => {
      callCount++;
      if (callCount === 1) return fetchResponseFromSse(fixtures.PARALLEL_TOOL_CALLS);
      return fetchResponseFromSse(fixtures.SIMPLE_HEBREW);
    });
    const s = new LLMSession({ apiKey: "k", logger: makeLogger(), toolSchema: [
      { type: "function", function: { name: "score_lead", description: "x", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "send_whatsapp", description: "x", parameters: { type: "object", properties: {} } } },
    ] });
    const calls = [];
    for await (const ev of s.run([{ role: "user", content: "hi" }])) {
      if (ev.type === "tool_call_request") {
        calls.push(ev);
        s.provideToolResult(ev.callId, JSON.stringify({ ok: true }));
      }
    }
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.name).sort()).toEqual(["score_lead", "send_whatsapp"]);
  });

  it("emits synthetic tool_result for malformed tool args", async () => {
    let secondRoundMessages = null;
    let callCount = 0;
    __setFetchForTests(async (url, opts) => {
      callCount++;
      if (callCount === 1) return fetchResponseFromSse(fixtures.TOOL_CALL_MALFORMED_ARGS);
      // Inspect the messages on the second call
      secondRoundMessages = JSON.parse(opts.body).messages;
      return fetchResponseFromSse(fixtures.SIMPLE_HEBREW);
    });
    const s = new LLMSession({ apiKey: "k", logger: makeLogger(), toolSchema: [
      { type: "function", function: { name: "score_lead", description: "x", parameters: { type: "object", properties: {} } } },
    ] });
    const gen = s.run([{ role: "user", content: "hi" }]);
    let toolReqCount = 0;
    for await (const ev of gen) {
      if (ev.type === "tool_call_request") {
        toolReqCount++;
        s.provideToolResult(ev.callId, JSON.stringify({ ok: true }));
      }
    }
    // No real tool_call_request should be emitted (malformed). The second
    // round should have a synthetic tool result indicating retry.
    expect(toolReqCount).toBe(0);
    const toolMsg = secondRoundMessages?.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.content).toMatch(/invalid|retry/i);
  });

  it("after MAX_TOOL_ROUNDS, forces tool_choice='none' on the next request", async () => {
    let callCount = 0;
    let lastBody = null;
    __setFetchForTests(async (url, opts) => {
      callCount++;
      lastBody = JSON.parse(opts.body);
      if (callCount <= 3) return fetchResponseFromSse(fixtures.TOOL_CALL_SPLIT_ARGS);
      return fetchResponseFromSse(fixtures.SIMPLE_HEBREW);
    });
    const s = new LLMSession({ apiKey: "k", logger: makeLogger(), toolSchema: [
      { type: "function", function: { name: "score_lead", description: "x", parameters: { type: "object", properties: {} } } },
    ] });
    for await (const ev of s.run([{ role: "user", content: "hi" }])) {
      if (ev.type === "tool_call_request") {
        s.provideToolResult(ev.callId, JSON.stringify({ ok: true }));
      }
    }
    // 4th request should have tool_choice='none'
    expect(callCount).toBeGreaterThanOrEqual(4);
    expect(lastBody.tool_choice).toBe("none");
  });
});

describe("LLMSession — retry policy", () => {
  beforeEach(() => { __setFetchForTests(null); });

  it("retries once on a 5xx then succeeds", async () => {
    let callCount = 0;
    __setFetchForTests(async () => {
      callCount++;
      if (callCount === 1) return new Response("server error", { status: 503 });
      return fetchResponseFromSse(fixtures.SIMPLE_HEBREW);
    });
    const s = new LLMSession({ apiKey: "k", logger: makeLogger() });
    const yielded = [];
    for await (const ev of s.run([{ role: "user", content: "hi" }])) yielded.push(ev);
    expect(callCount).toBe(2);
    expect(yielded.find((e) => e.type === "done")).toBeTruthy();
  });

  it("retries twice on 5xx then fails with llm_failed", async () => {
    let callCount = 0;
    __setFetchForTests(async () => {
      callCount++;
      return new Response("server error", { status: 500 });
    });
    const s = new LLMSession({ apiKey: "k", logger: makeLogger() });
    const gen = s.run([{ role: "user", content: "hi" }]);
    let err;
    try {
      for await (const ev of gen) {}
    } catch (e) {
      err = e;
    }
    expect(callCount).toBe(3); // initial + 2 retries
    expect(err).toBeTruthy();
    expect(err.code).toBe("llm_failed");
  });

  it("honors retry-after header on 429", async () => {
    let callCount = 0;
    let firstRetryAt = null;
    const t0 = Date.now();
    __setFetchForTests(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
      }
      firstRetryAt = Date.now();
      return fetchResponseFromSse(fixtures.SIMPLE_HEBREW);
    });
    const s = new LLMSession({ apiKey: "k", logger: makeLogger() });
    for await (const ev of s.run([{ role: "user", content: "hi" }])) {}
    const delta = firstRetryAt - t0;
    expect(delta).toBeGreaterThanOrEqual(900); // ~1s retry-after
    expect(delta).toBeLessThan(2500);
  });

  it("does NOT retry on 4xx (non-429)", async () => {
    let callCount = 0;
    __setFetchForTests(async () => {
      callCount++;
      return new Response("bad request", { status: 400 });
    });
    const s = new LLMSession({ apiKey: "k", logger: makeLogger() });
    let err;
    try {
      for await (const ev of s.run([{ role: "user", content: "hi" }])) {}
    } catch (e) { err = e; }
    expect(callCount).toBe(1);
    expect(err.code).toBe("llm_bad_request");
  });
});
