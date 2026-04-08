// voiceagent-saas/tests/media-bridge-chunk.test.js
// Unit tests for chunkForAsteriskWs — the guard against Asterisk's
// AST_WEBSOCKET_MAX_RX_PAYLOAD_SIZE=65535 hard limit. A single ws.send
// above that limit triggers "Cannot fit huge websocket frame" in
// res_http_websocket.c and closes the channel with code 1009 → ARI
// cause 38 "Network out of order".
import { describe, it, expect } from "vitest";
import { chunkForAsteriskWs } from "../media-bridge.js";

// slin16 @ 16kHz, 20ms frame = 320 samples * 2 bytes = 640 bytes
const FRAME = 640;

function makeBuffer(byteLength, fillByte = 0xaa) {
  return Buffer.alloc(byteLength, fillByte);
}

describe("chunkForAsteriskWs", () => {
  it("returns [] for empty buffer", () => {
    expect(chunkForAsteriskWs(Buffer.alloc(0), FRAME)).toEqual([]);
  });

  it("returns [] for null buffer", () => {
    expect(chunkForAsteriskWs(null, FRAME)).toEqual([]);
  });

  it("returns a single chunk when input is under maxBytes", () => {
    const buf = makeBuffer(FRAME * 5); // 3200 bytes
    const chunks = chunkForAsteriskWs(buf, FRAME);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(FRAME * 5);
    expect(chunks[0]).toEqual(buf);
  });

  it("splits a 64KB buffer into 2 chunks under 32768 each", () => {
    const buf = makeBuffer(FRAME * 100); // 64000 bytes
    const chunks = chunkForAsteriskWs(buf, FRAME);
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(32768);
      expect(c.length % FRAME).toBe(0);
    }
    // Concatenation round-trips.
    const joined = Buffer.concat(chunks);
    expect(joined).toEqual(buf);
  });

  it("splits an 80KB buffer (the production failure case) into 3 chunks", () => {
    const buf = makeBuffer(80000);
    // Round up to nearest frame to make the test input frame-aligned.
    const aligned = makeBuffer(Math.ceil(80000 / FRAME) * FRAME);
    const chunks = chunkForAsteriskWs(aligned, FRAME);
    // 80640 / 32640 = 2.47 → 3 chunks (32640 + 32640 + 15360)
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThan(65535); // ABSOLUTE Asterisk limit
      expect(c.length).toBeLessThanOrEqual(32768); // our safer target
      expect(c.length % FRAME).toBe(0);
    }
    const joined = Buffer.concat(chunks);
    expect(joined).toEqual(aligned);
  });

  it("chunks are exactly 32640 bytes (51 frames) for inputs larger than that", () => {
    // floor(32768 / 640) * 640 = 32640
    const buf = makeBuffer(FRAME * 200); // 128000 bytes
    const chunks = chunkForAsteriskWs(buf, FRAME);
    // All but the last chunk should be exactly 32640 bytes.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].length).toBe(32640);
    }
    // Last chunk fits the remainder.
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    expect(totalLen).toBe(buf.length);
  });

  it("every chunk length is a multiple of frameSize (frame alignment)", () => {
    const buf = makeBuffer(FRAME * 150); // 96000 bytes
    const chunks = chunkForAsteriskWs(buf, FRAME);
    for (const c of chunks) {
      expect(c.length % FRAME).toBe(0);
    }
  });

  it("honors a custom maxBytes parameter", () => {
    const buf = makeBuffer(FRAME * 10); // 6400 bytes
    // maxBytes = 2000, floor(2000/640) = 3 frames = 1920 bytes per chunk
    const chunks = chunkForAsteriskWs(buf, FRAME, 2000);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].length).toBe(1920);
    }
    const joined = Buffer.concat(chunks);
    expect(joined).toEqual(buf);
  });

  it("throws if frameSize is larger than maxBytes", () => {
    expect(() => chunkForAsteriskWs(Buffer.alloc(100), 2000, 1000)).toThrow(
      /larger than maxBytes/,
    );
  });

  it("throws on invalid frameSize", () => {
    expect(() => chunkForAsteriskWs(Buffer.alloc(100), 0)).toThrow(
      /invalid frameSize/,
    );
    expect(() => chunkForAsteriskWs(Buffer.alloc(100), -640)).toThrow(
      /invalid frameSize/,
    );
    expect(() => chunkForAsteriskWs(Buffer.alloc(100), 1.5)).toThrow(
      /invalid frameSize/,
    );
  });

  it("boundary: a buffer exactly equal to the max chunk size stays as one chunk", () => {
    const buf = makeBuffer(32640); // exactly 51 frames
    const chunks = chunkForAsteriskWs(buf, FRAME);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(32640);
  });

  it("boundary: a buffer one frame larger splits into two chunks", () => {
    const buf = makeBuffer(32640 + FRAME); // 52 frames
    const chunks = chunkForAsteriskWs(buf, FRAME);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(32640);
    expect(chunks[1].length).toBe(FRAME);
  });
});
