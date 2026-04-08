// voiceagent-saas/tests/vad.test.js
// Unit tests for the createSilenceDetector factory.
// Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md §4.4
import { describe, it, expect, beforeEach } from "vitest";
import { createSilenceDetector } from "../vad.js";

// Build a slin16 PCM16 LE buffer of N samples, all set to `value`.
// Sample count 320 = one 20ms frame at 16 kHz.
function makeBuffer(value, sampleCount = 320) {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
}

function makeDetector(overrides = {}) {
  return createSilenceDetector({
    threshold: 800,
    debounceMs: 700,
    consecutiveSilentFrames: 3,
    ...overrides,
  });
}

describe("createSilenceDetector — harness sanity", () => {
  it("can construct a detector and call its methods without throwing", () => {
    const vad = makeDetector();
    expect(vad).toBeDefined();
    expect(typeof vad.pushChunk).toBe("function");
    expect(typeof vad.setMuted).toBe("function");
    expect(typeof vad.resolvePending).toBe("function");
    expect(typeof vad.getUserStoppedAt).toBe("function");
    expect(typeof vad.reset).toBe("function");
    expect(vad.getUserStoppedAt()).toBe(null);
  });
});

describe("RMS calculation", () => {
  it("all-zero buffer → RMS is 0 → silent (getUserStoppedAt stays null alone)", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(0), 1000);
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("constant 1000 square wave → RMS 1000 → speaking (above 800)", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(1000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    expect(vad.getUserStoppedAt()).toBe(null);
    vad.pushChunk(makeBuffer(0), 1760);
    expect(vad.getUserStoppedAt()).not.toBe(null);
  });

  it("constant 700 square wave → RMS 700 → silent (below 800)", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(2000), 1000);
    vad.pushChunk(makeBuffer(700), 1020);
    vad.pushChunk(makeBuffer(700), 1040);
    vad.pushChunk(makeBuffer(700), 1060);
    expect(vad.getUserStoppedAt()).toBe(null);
    vad.pushChunk(makeBuffer(700), 1760);
    expect(vad.getUserStoppedAt()).not.toBe(null);
  });

  it("threshold boundary: RMS 799 is silent, RMS 800 is speech", () => {
    let vad = makeDetector();
    vad.pushChunk(makeBuffer(800), 1000);
    vad.pushChunk(makeBuffer(799), 1020);
    vad.pushChunk(makeBuffer(799), 1040);
    vad.pushChunk(makeBuffer(799), 1060);
    vad.pushChunk(makeBuffer(799), 1760);
    expect(vad.getUserStoppedAt()).not.toBe(null);

    vad = makeDetector();
    vad.pushChunk(makeBuffer(2000), 1000);
    vad.pushChunk(makeBuffer(800), 1020);
    vad.pushChunk(makeBuffer(800), 1040);
    vad.pushChunk(makeBuffer(800), 1060);
    vad.pushChunk(makeBuffer(800), 1760);
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("sign extension: sample -10000 reads as -10000 (not unsigned 55536)", () => {
    const vad2 = makeDetector({ threshold: 20000 });
    vad2.pushChunk(makeBuffer(25000), 1000);
    vad2.pushChunk(makeBuffer(-10000), 1020);
    vad2.pushChunk(makeBuffer(-10000), 1040);
    vad2.pushChunk(makeBuffer(-10000), 1060);
    vad2.pushChunk(makeBuffer(-10000), 1760);
    expect(vad2.getUserStoppedAt()).not.toBe(null);
  });
});

describe("state machine — silence transitions", () => {
  it("pure silence from start → getUserStoppedAt stays null", () => {
    const vad = makeDetector();
    for (let t = 1000; t < 3000; t += 20) {
      vad.pushChunk(makeBuffer(0), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("continuous speech → getUserStoppedAt stays null", () => {
    const vad = makeDetector();
    for (let t = 1000; t < 3000; t += 20) {
      vad.pushChunk(makeBuffer(5000), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("speech → 1 quiet frame → speech → no transition", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(5000), 1040);
    for (let t = 1060; t < 2500; t += 20) {
      vad.pushChunk(makeBuffer(5000), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("speech → 2 quiet frames → speech → no transition", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(5000), 1060);
    for (let t = 1080; t < 2500; t += 20) {
      vad.pushChunk(makeBuffer(5000), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("speech → 3 quiet frames → silence transition; silenceStartAt backdated 40ms", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060); // third silent frame: silenceStartAt = 1060 - 40 = 1020
    vad.pushChunk(makeBuffer(0), 1720); // 1720 - 1020 = 700ms → exactly at debounce
    expect(vad.getUserStoppedAt()).toBe(1020);
  });

  it("once resolved, getUserStoppedAt is idempotent", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    const first = vad.getUserStoppedAt();
    vad.pushChunk(makeBuffer(0), 1740);
    vad.pushChunk(makeBuffer(0), 1760);
    expect(vad.getUserStoppedAt()).toBe(first);
  });

  it("speech resumes after resolved silence → userStoppedAt cleared", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    expect(vad.getUserStoppedAt()).not.toBe(null);
    vad.pushChunk(makeBuffer(5000), 1740);
    expect(vad.getUserStoppedAt()).toBe(null);
  });
});

describe("resolvePending", () => {
  it("force-resolves mid-debounce", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    expect(vad.getUserStoppedAt()).toBe(null);
    vad.resolvePending(1200);
    expect(vad.getUserStoppedAt()).toBe(1020);
  });

  it("no-op when already resolved", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    const first = vad.getUserStoppedAt();
    vad.resolvePending(9999);
    expect(vad.getUserStoppedAt()).toBe(first);
  });

  it("no-op when no silence ever seen", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.resolvePending(1200);
    expect(vad.getUserStoppedAt()).toBe(null);
  });
});

describe("reset", () => {
  it("clears isSpeaking, silence state, and userStoppedAt", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    expect(vad.getUserStoppedAt()).not.toBe(null);
    vad.reset();
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("reset does NOT clear muted state", () => {
    const vad = makeDetector();
    vad.setMuted(true);
    vad.reset();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(makeBuffer(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1720);
    expect(vad.getUserStoppedAt()).toBe(null);
  });
});

describe("setMuted", () => {
  it("muted → pushChunk is a no-op", () => {
    const vad = makeDetector();
    vad.setMuted(true);
    vad.pushChunk(makeBuffer(30000), 1000);
    vad.setMuted(false);
    for (let t = 1020; t < 3000; t += 20) {
      vad.pushChunk(makeBuffer(0), t);
    }
    expect(vad.getUserStoppedAt()).toBe(null);
  });

  it("unmute re-enables pushChunk", () => {
    const vad = makeDetector();
    vad.setMuted(true);
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.setMuted(false);
    vad.pushChunk(makeBuffer(5000), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1080);
    vad.pushChunk(makeBuffer(0), 1780);
    expect(vad.getUserStoppedAt()).toBe(1040);
  });
});

describe("defensive buffer guards", () => {
  it("zero-length buffer → no throw, no state change", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(Buffer.alloc(0), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1080);
    vad.pushChunk(makeBuffer(0), 1780);
    expect(vad.getUserStoppedAt()).toBe(1040);
  });

  it("odd-length buffer → no throw, no state change", () => {
    const vad = makeDetector();
    vad.pushChunk(makeBuffer(5000), 1000);
    vad.pushChunk(Buffer.alloc(641), 1020);
    vad.pushChunk(makeBuffer(0), 1040);
    vad.pushChunk(makeBuffer(0), 1060);
    vad.pushChunk(makeBuffer(0), 1080);
    vad.pushChunk(makeBuffer(0), 1780);
    expect(vad.getUserStoppedAt()).toBe(1040);
  });
});
