// voiceagent-saas/tests/tts-session.test.js
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §5.3
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

let lastMockWs = null;
class MockWebSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    lastMockWs = this;
  }
  send(data) { this.sent.push(data); }
  close(code, reason) {
    this.readyState = 3;
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }
  _open() { this.readyState = 1; this.emit("open"); }
  _msg(obj) { this.emit("message", Buffer.from(JSON.stringify(obj))); }
}
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSED = 3;

vi.mock("ws", () => ({ default: MockWebSocket }));

const { TTSSession } = await import("../tts-session.js");

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

describe("TTSSession — constructor", () => {
  it("requires apiKey", () => {
    expect(() => new TTSSession({ voiceId: "v", logger: makeLogger() })).toThrow(/apiKey/);
  });
  it("requires voiceId", () => {
    expect(() => new TTSSession({ apiKey: "k", logger: makeLogger() })).toThrow(/voiceId/);
  });
  it("requires logger", () => {
    expect(() => new TTSSession({ apiKey: "k", voiceId: "v" })).toThrow(/logger/);
  });
  it("defaults modelId to eleven_turbo_v2_5", () => {
    const s = new TTSSession({ apiKey: "k", voiceId: "v", logger: makeLogger() });
    expect(s.modelId).toBe("eleven_turbo_v2_5");
  });
});

describe("TTSSession — start()", () => {
  beforeEach(() => { lastMockWs = null; });

  it("opens WS to the correct URL with model_id=eleven_turbo_v2_5", async () => {
    const s = new TTSSession({ apiKey: "k", voiceId: "v123", logger: makeLogger() });
    const p = s.start();
    lastMockWs._open();
    await p;
    expect(lastMockWs.url).toContain("/v1/text-to-speech/v123/stream-input");
    expect(lastMockWs.url).toContain("model_id=eleven_turbo_v2_5");
    expect(lastMockWs.url).toContain("output_format=pcm_16000");
    expect(lastMockWs.url).toContain("optimize_streaming_latency=3");
  });

  it("sends xi-api-key header", async () => {
    const s = new TTSSession({ apiKey: "my-key", voiceId: "v", logger: makeLogger() });
    const p = s.start();
    lastMockWs._open();
    await p;
    expect(lastMockWs.opts.headers["xi-api-key"]).toBe("my-key");
  });

  it("sends BOS frame containing voice_settings AND xi_api_key in body", async () => {
    const s = new TTSSession({ apiKey: "key1", voiceId: "v", logger: makeLogger() });
    const p = s.start();
    lastMockWs._open();
    await p;
    expect(lastMockWs.sent.length).toBeGreaterThanOrEqual(1);
    const bos = JSON.parse(lastMockWs.sent[0]);
    expect(bos.text).toBe(" ");
    expect(bos.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.8, speed: 1.0 });
    expect(bos.xi_api_key).toBe("key1"); // EL footgun: required in body too
  });

  it("retries once on initial WS error after 300ms", async () => {
    vi.useFakeTimers();
    const s = new TTSSession({ apiKey: "k", voiceId: "v", logger: makeLogger() });
    const p = s.start();
    const firstWs = lastMockWs;
    firstWs.emit("error", new Error("connect failed"));
    // Should construct a new WS after ~300ms
    await vi.advanceTimersByTimeAsync(350);
    expect(lastMockWs).not.toBe(firstWs);
    lastMockWs._open();
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
  });

  it("rejects with tts_init_failed if both attempts fail", async () => {
    vi.useFakeTimers();
    const s = new TTSSession({ apiKey: "k", voiceId: "v", logger: makeLogger() });
    const p = s.start();
    lastMockWs.emit("error", new Error("connect failed"));
    await vi.advanceTimersByTimeAsync(350);
    lastMockWs.emit("error", new Error("connect failed again"));
    let err;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.code).toBe("tts_init_failed");
    vi.useRealTimers();
  });
});

describe("TTSSession — pushSentence", () => {
  beforeEach(() => { lastMockWs = null; });

  it("queues sentences pushed before WS opens, drains on open", async () => {
    const s = new TTSSession({ apiKey: "k", voiceId: "v", logger: makeLogger() });
    const p = s.start();
    s.pushSentence("first sentence");
    s.pushSentence("second sentence");
    expect(lastMockWs.sent.length).toBe(0); // not opened yet, nothing sent
    lastMockWs._open();
    await p;
    // After open: BOS + 2 sentences = 3 sends
    expect(lastMockWs.sent.length).toBe(3);
    const sentences = lastMockWs.sent.slice(1).map((s) => JSON.parse(s));
    expect(sentences[0].text).toBe("first sentence ");
    expect(sentences[0].try_trigger_generation).toBe(true);
    expect(sentences[1].text).toBe("second sentence ");
  });

  it("forwards sentences immediately when WS is already open", async () => {
    const s = new TTSSession({ apiKey: "k", voiceId: "v", logger: makeLogger() });
    const p = s.start();
    lastMockWs._open();
    await p;
    s.pushSentence("hello world");
    // BOS + sentence
    expect(lastMockWs.sent.length).toBe(2);
    const last = JSON.parse(lastMockWs.sent[1]);
    expect(last.text).toBe("hello world ");
  });

  it("tracks totalChars across all pushed sentences", async () => {
    const s = new TTSSession({ apiKey: "k", voiceId: "v", logger: makeLogger() });
    const p = s.start();
    lastMockWs._open();
    await p;
    s.pushSentence("שלום");      // 4 chars
    s.pushSentence("איך אתה?");   // 8 chars
    expect(s._totalChars).toBe(4 + 8);
  });

  it("ignores empty/whitespace pushSentence calls", async () => {
    const s = new TTSSession({ apiKey: "k", voiceId: "v", logger: makeLogger() });
    const p = s.start();
    lastMockWs._open();
    await p;
    const before = lastMockWs.sent.length;
    s.pushSentence("");
    s.pushSentence("   ");
    expect(lastMockWs.sent.length).toBe(before);
  });
});
