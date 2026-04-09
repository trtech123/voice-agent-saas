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
