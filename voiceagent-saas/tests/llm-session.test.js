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
