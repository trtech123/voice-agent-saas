// voiceagent-saas/tests/deepgram-session.test.js
// Unit tests for DeepgramSession with a mocked WebSocket.
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §5.1
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// Mock the ws module BEFORE importing DeepgramSession.
let lastMockWs = null;
class MockWebSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    lastMockWs = this;
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.readyState = 3; // CLOSED
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }
  // Helpers for tests:
  _open() {
    this.readyState = 1;
    this.emit("open");
  }
  _msg(obj) {
    this.emit("message", Buffer.from(JSON.stringify(obj)));
  }
}
MockWebSocket.OPEN = 1;
MockWebSocket.CONNECTING = 0;
MockWebSocket.CLOSED = 3;

vi.mock("ws", () => ({ default: MockWebSocket }));

const { DeepgramSession } = await import("../deepgram-session.js");

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

describe("DeepgramSession — constructor", () => {
  it("requires an apiKey", () => {
    expect(() => new DeepgramSession({ logger: makeLogger() })).toThrow(/apiKey/);
  });

  it("requires a logger", () => {
    expect(() => new DeepgramSession({ apiKey: "x" })).toThrow(/logger/);
  });

  it("constructs successfully with apiKey and logger", () => {
    const s = new DeepgramSession({ apiKey: "x", logger: makeLogger() });
    expect(s).toBeTruthy();
  });
});

describe("DeepgramSession — connect()", () => {
  beforeEach(() => { lastMockWs = null; });

  it("opens WS with the correct base URL", async () => {
    const s = new DeepgramSession({ apiKey: "k", logger: makeLogger() });
    const p = s.connect();
    lastMockWs._open();
    await p;
    expect(lastMockWs.url).toMatch(/^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  });

  it("includes model=nova-2, language=he, encoding=linear16 in query string", async () => {
    const s = new DeepgramSession({ apiKey: "k", logger: makeLogger() });
    const p = s.connect();
    lastMockWs._open();
    await p;
    expect(lastMockWs.url).toContain("model=nova-2");
    expect(lastMockWs.url).toContain("language=he");
    expect(lastMockWs.url).toContain("encoding=linear16");
    expect(lastMockWs.url).toContain("sample_rate=16000");
    expect(lastMockWs.url).toContain("channels=1");
    expect(lastMockWs.url).toContain("interim_results=true");
    expect(lastMockWs.url).toContain("utterance_end_ms=700");
    expect(lastMockWs.url).toContain("smart_format=true");
    expect(lastMockWs.url).toContain("vad_events=true");
  });

  it("does NOT include endpointing param (turn commit is owned by our VAD)", async () => {
    const s = new DeepgramSession({ apiKey: "k", logger: makeLogger() });
    const p = s.connect();
    lastMockWs._open();
    await p;
    expect(lastMockWs.url).not.toContain("endpointing=");
  });

  it("sends Authorization: Token <key> header", async () => {
    const s = new DeepgramSession({ apiKey: "my-key", logger: makeLogger() });
    const p = s.connect();
    lastMockWs._open();
    await p;
    expect(lastMockWs.opts.headers.Authorization).toBe("Token my-key");
  });

  it("emits ws_open event when WS opens", async () => {
    const s = new DeepgramSession({ apiKey: "k", logger: makeLogger() });
    const wsOpenSpy = vi.fn();
    s.on("ws_open", wsOpenSpy);
    const p = s.connect();
    lastMockWs._open();
    await p;
    expect(wsOpenSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects with dg_connect_failed if WS errors before open", async () => {
    const s = new DeepgramSession({ apiKey: "k", logger: makeLogger() });
    const p = s.connect();
    lastMockWs.emit("error", new Error("ECONNREFUSED"));
    await expect(p).rejects.toMatchObject({ code: "dg_connect_failed" });
  });

  it("model and language can be overridden via constructor", async () => {
    const s = new DeepgramSession({ apiKey: "k", logger: makeLogger(), model: "nova-3", language: "en" });
    const p = s.connect();
    lastMockWs._open();
    await p;
    expect(lastMockWs.url).toContain("model=nova-3");
    expect(lastMockWs.url).toContain("language=en");
  });
});

describe("DeepgramSession — message dispatch", () => {
  let s;
  beforeEach(async () => {
    lastMockWs = null;
    s = new DeepgramSession({ apiKey: "k", logger: makeLogger() });
    const p = s.connect();
    lastMockWs._open();
    await p;
  });

  it("emits 'partial' for an interim transcript", () => {
    const partialSpy = vi.fn();
    s.on("partial", partialSpy);
    lastMockWs._msg({
      type: "Results",
      is_final: false,
      speech_final: false,
      channel: { alternatives: [{ transcript: "שלום", confidence: 0.95 }] },
    });
    expect(partialSpy).toHaveBeenCalledTimes(1);
    const arg = partialSpy.mock.calls[0][0];
    expect(arg.text).toBe("שלום");
    expect(arg.confidence).toBe(0.95);
    expect(arg.is_final).toBe(false);
    expect(arg.speech_final).toBe(false);
    expect(typeof arg.ts).toBe("number");
  });

  it("emits 'final' for is_final=true", () => {
    const finalSpy = vi.fn();
    s.on("final", finalSpy);
    lastMockWs._msg({
      type: "Results",
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{ transcript: "שלום עולם", confidence: 0.99 }] },
    });
    expect(finalSpy).toHaveBeenCalledTimes(1);
    expect(finalSpy.mock.calls[0][0].text).toBe("שלום עולם");
    expect(finalSpy.mock.calls[0][0].is_final).toBe(true);
  });

  it("emits 'utterance_end' on UtteranceEnd message", () => {
    const ueSpy = vi.fn();
    s.on("utterance_end", ueSpy);
    lastMockWs._msg({ type: "UtteranceEnd", channel: [0], last_word_end: 1.234 });
    expect(ueSpy).toHaveBeenCalledTimes(1);
    expect(typeof ueSpy.mock.calls[0][0].ts).toBe("number");
  });

  it("emits 'speech_started' on SpeechStarted message", () => {
    const ssSpy = vi.fn();
    s.on("speech_started", ssSpy);
    lastMockWs._msg({ type: "SpeechStarted", timestamp: 0.5 });
    expect(ssSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores empty transcripts", () => {
    const partialSpy = vi.fn();
    s.on("partial", partialSpy);
    lastMockWs._msg({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: "", confidence: 0.5 }] },
    });
    expect(partialSpy).not.toHaveBeenCalled();
  });

  it("ignores Metadata messages without throwing", () => {
    expect(() => {
      lastMockWs._msg({ type: "Metadata", request_id: "abc" });
    }).not.toThrow();
  });

  it("ignores malformed JSON without throwing", () => {
    expect(() => {
      lastMockWs.emit("message", Buffer.from("not json"));
    }).not.toThrow();
  });
});
