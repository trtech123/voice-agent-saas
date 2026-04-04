// apps/voice-engine/tests/audio-utils.test.ts
import { describe, it, expect } from "vitest";
import { computeRms, createSilenceBuffer, SPEECH_RMS_THRESHOLD } from "../src/audio-utils.js";

describe("computeRms", () => {
  it("returns 0 for an empty buffer", () => {
    const buf = Buffer.alloc(0);
    expect(computeRms(buf)).toBe(0);
  });

  it("returns 0 for a silence buffer (all zeros)", () => {
    const buf = Buffer.alloc(320); // 160 samples of silence
    expect(computeRms(buf)).toBe(0);
  });

  it("computes correct RMS for a known signal", () => {
    // 4 samples: [1000, -1000, 1000, -1000]
    // RMS = sqrt((1000^2 + 1000^2 + 1000^2 + 1000^2) / 4) = 1000
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(1000, 0);
    buf.writeInt16LE(-1000, 2);
    buf.writeInt16LE(1000, 4);
    buf.writeInt16LE(-1000, 6);
    expect(computeRms(buf)).toBe(1000);
  });

  it("handles odd-length buffers by rounding down", () => {
    // 5 bytes = 2 full samples (4 bytes), 1 leftover byte ignored
    const buf = Buffer.alloc(5);
    buf.writeInt16LE(500, 0);
    buf.writeInt16LE(500, 2);
    // 5th byte is ignored
    expect(computeRms(buf)).toBe(500);
  });

  it("returns RMS above threshold for typical speech", () => {
    // Simulate speech-level audio (~2000 RMS)
    const samples = 160;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const value = Math.round(2000 * Math.sin(2 * Math.PI * i / 20));
      buf.writeInt16LE(value, i * 2);
    }
    const rms = computeRms(buf);
    expect(rms).toBeGreaterThan(SPEECH_RMS_THRESHOLD);
  });
});

describe("createSilenceBuffer", () => {
  it("creates a buffer of the correct size for given duration and sample rate", () => {
    // 300ms at 16kHz mono 16-bit = 16000 * 0.3 * 2 = 9600 bytes
    const buf = createSilenceBuffer(300, 16000);
    expect(buf.length).toBe(9600);
  });

  it("creates an all-zero buffer", () => {
    const buf = createSilenceBuffer(100, 16000);
    const allZero = buf.every((byte) => byte === 0);
    expect(allZero).toBe(true);
  });
});

describe("SPEECH_RMS_THRESHOLD", () => {
  it("is a positive number", () => {
    expect(SPEECH_RMS_THRESHOLD).toBeGreaterThan(0);
  });
});
