#!/usr/bin/env node
// voiceagent-saas/scripts/probe-llm.js
//
// Live probe of LLMSession against the real OpenAI API. Sends a tiny
// Hebrew sales prompt + a fake user turn, prints all yielded events.
//
// Usage: OPENAI_API_KEY=<key> node scripts/probe-llm.js

import { LLMSession } from "../llm-session.js";
import { buildOpenAIToolSchema } from "../tools.js";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("OPENAI_API_KEY env required");
  process.exit(1);
}

const log = {
  info: (...a) => console.log("INFO ", ...a),
  warn: (...a) => console.log("WARN ", ...a),
  error: (...a) => console.log("ERROR", ...a),
  debug: () => {},
  child: function () { return this; },
};

const messages = [
  {
    role: "system",
    content:
      "אתה דני, סוכן מכירות קולי של Voice Agent. דבר רק בעברית, בקיצור. שאל שאלה אחת בכל פעם.",
  },
  { role: "assistant", content: "שלום, אני דני מ-Voice Agent. יש לך עסק פעיל?" },
  { role: "user", content: "כן, יש לי מסעדה." },
];

const s = new LLMSession({
  apiKey: KEY,
  logger: log,
  toolSchema: buildOpenAIToolSchema(),
});

const t0 = Date.now();
let firstSentenceAt = null;
for await (const ev of s.run(messages)) {
  const dt = Date.now() - t0;
  if (ev.type === "sentence") {
    if (!firstSentenceAt) {
      firstSentenceAt = dt;
      console.log(`[+${dt}ms] FIRST SENTENCE: ${ev.text}`);
    } else {
      console.log(`[+${dt}ms] sentence: ${ev.text}`);
    }
  } else if (ev.type === "tool_call_request") {
    console.log(`[+${dt}ms] tool_call_request: ${ev.name}(${JSON.stringify(ev.args)})`);
    s.provideToolResult(ev.callId, JSON.stringify({ ok: true }));
  } else if (ev.type === "usage") {
    console.log(`[+${dt}ms] usage: in=${ev.tokens_in} out=${ev.tokens_out}`);
  } else if (ev.type === "done") {
    console.log(`[+${dt}ms] done: ${ev.totalTokensIn} in / ${ev.totalTokensOut} out`);
  }
}
