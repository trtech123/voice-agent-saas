#!/usr/bin/env node
// voiceagent-saas/scripts/probe-deepgram.js
//
// Live probe of the DeepgramSession adapter against the real Deepgram API.
// Streams 3 seconds of silence followed by a synthetic 440Hz tone, prints
// every event the session emits, then closes.
//
// Usage: DEEPGRAM_API_KEY=<key> node scripts/probe-deepgram.js

import { DeepgramSession } from "../deepgram-session.js";

const KEY = process.env.DEEPGRAM_API_KEY;
if (!KEY) {
  console.error("DEEPGRAM_API_KEY env required");
  process.exit(1);
}

const log = {
  info: (obj, msg) => console.log("INFO ", msg || "", obj || ""),
  warn: (obj, msg) => console.log("WARN ", msg || "", obj || ""),
  error: (obj, msg) => console.log("ERROR", msg || "", obj || ""),
  debug: () => {},
  child: function () { return this; },
};

const s = new DeepgramSession({ apiKey: KEY, logger: log });

s.on("ws_open", () => console.log("[evt] ws_open"));
s.on("partial", (e) => console.log("[evt] partial:", JSON.stringify(e)));
s.on("final", (e) => console.log("[evt] final:", JSON.stringify(e)));
s.on("utterance_end", (e) => console.log("[evt] utterance_end:", JSON.stringify(e)));
s.on("speech_started", (e) => console.log("[evt] speech_started:", JSON.stringify(e)));
s.on("error", (err) => console.log("[evt] error:", err.code, err.message));
s.on("closed", (e) => console.log("[evt] closed:", JSON.stringify(e)));

await s.connect();

// Send 3 seconds of silence (150 frames of 20ms slin16 silence).
const silentFrame = Buffer.alloc(640);
for (let i = 0; i < 150; i++) {
  s.sendAudio(silentFrame);
  await new Promise((r) => setTimeout(r, 20));
}

// Send 1 second of a 440Hz tone (50 frames). Hebrew language can't transcribe
// a sine wave, so this should produce empty results — but the WS should stay
// alive and we should see Metadata frames.
for (let i = 0; i < 50; i++) {
  const buf = Buffer.alloc(640);
  for (let j = 0; j < 320; j++) {
    const t = (i * 320 + j) / 16000;
    const sample = Math.round(8000 * Math.sin(2 * Math.PI * 440 * t));
    buf.writeInt16LE(sample, j * 2);
  }
  s.sendAudio(buf);
  await new Promise((r) => setTimeout(r, 20));
}

// Wait 1s for any trailing transcripts, then close.
await new Promise((r) => setTimeout(r, 1000));
s.finish();
await new Promise((r) => setTimeout(r, 500));
s.close("probe_done");
process.exit(0);
