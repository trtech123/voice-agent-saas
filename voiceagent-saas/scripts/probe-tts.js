#!/usr/bin/env node
// voiceagent-saas/scripts/probe-tts.js
//
// Live probe of TTSSession against the real ElevenLabs API. Productionized
// version of the spike script that confirmed eleven_turbo_v2_5 works on
// stream-input WS with Hebrew on 2026-04-08 (~148ms first-byte).
//
// Usage: ELEVENLABS_API_KEY=<key> node scripts/probe-tts.js

import { TTSSession } from "../tts-session.js";

const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE = process.env.ELEVENLABS_VOICE_ID || "9i2kmIrFwyBhu8sTYm07";

if (!KEY) {
  console.error("ELEVENLABS_API_KEY env required");
  process.exit(1);
}

const log = {
  info: (obj, msg) => console.log("INFO ", msg || "", obj || ""),
  warn: (obj, msg) => console.log("WARN ", msg || "", obj || ""),
  error: (obj, msg) => console.log("ERROR", msg || "", obj || ""),
  debug: () => {},
  child: function () { return this; },
};

const s = new TTSSession({ apiKey: KEY, voiceId: VOICE, logger: log });

const t0 = Date.now();
let firstByteAt = null;
let totalBytes = 0;

s.on("audio", (buf) => {
  totalBytes += buf.length;
  if (!firstByteAt) {
    firstByteAt = Date.now();
    console.log(`FIRST AUDIO at +${firstByteAt - t0}ms, ${buf.length} bytes`);
  }
});
s.on("done", (e) => {
  console.log(`DONE at +${Date.now() - t0}ms, totalChars=${e.totalChars}, totalBytes=${totalBytes}`);
});
s.on("error", (err) => {
  console.log("ERROR:", err.code, err.message);
  process.exit(1);
});
s.on("stopped", () => console.log("STOPPED"));

await s.start();
console.log(`WS open at +${Date.now() - t0}ms`);

s.pushSentence("שלום, אני דני מ-Voice Agent.");
s.pushSentence("יש לי כמה שאלות קצרות, אפשר?");
s.finish();

// Wait for done
await new Promise((r) => setTimeout(r, 4000));
process.exit(0);
