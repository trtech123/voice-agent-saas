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
