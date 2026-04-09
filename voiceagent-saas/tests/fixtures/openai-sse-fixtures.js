// voiceagent-saas/tests/fixtures/openai-sse-fixtures.js
//
// Hand-crafted SSE response bodies that match OpenAI's streaming chat
// completions wire format. Used by llm-session unit tests to drive the
// adapter through realistic edge cases without hitting the network.
//
// SSE format reminder: each event is `data: <json>\n\n`. The stream ends
// with `data: [DONE]\n\n`. Token deltas can be split across many events.
//
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §5.2

/** Build an SSE event line. */
function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Build a content delta event. */
function delta(text, finishReason = null) {
  return sse({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: finishReason,
      },
    ],
  });
}

/** Build a tool-call delta event. Args is a partial JSON string fragment. */
function toolCallDelta({ index = 0, id, name, argsFragment }) {
  const tc = { index };
  if (id) tc.id = id;
  if (name || argsFragment != null) {
    tc.function = {};
    if (name) tc.function.name = name;
    if (argsFragment != null) tc.function.arguments = argsFragment;
  }
  return sse({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
  });
}

function done(finishReason = "stop") {
  return sse({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
}

function usage(in_, out) {
  return sse({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: in_, completion_tokens: out, total_tokens: in_ + out },
  });
}

const TERM = "data: [DONE]\n\n";

/** Single short Hebrew sentence ending in a period. */
export const SIMPLE_HEBREW = [
  delta("שלום, "),
  delta("איך אפשר "),
  delta("לעזור לך?"),
  done("stop"),
  usage(120, 8),
  TERM,
].join("");

/** Two sentences in one response. */
export const TWO_SENTENCES = [
  delta("אה, סבבה. "),
  delta("תגיד לי, "),
  delta("יש לך עסק פעיל? "),
  delta("אני שואל כי "),
  delta("זה רלוונטי לחברה שלנו."),
  done("stop"),
  usage(150, 18),
  TERM,
].join("");

/** First sentence flushes immediately even though it's only 2 words. */
export const SHORT_FIRST_SENTENCE = [
  delta("מעולה. "),
  delta("עכשיו, "),
  delta("יש לך כמה זמן לעסק הזה?"),
  done("stop"),
  usage(100, 12),
  TERM,
].join("");

/** Tool call with arguments split across 5 deltas (realistic streaming). */
export const TOOL_CALL_SPLIT_ARGS = [
  toolCallDelta({ id: "call_abc", name: "score_lead" }),
  toolCallDelta({ argsFragment: '{"sc' }),
  toolCallDelta({ argsFragment: 'ore":' }),
  toolCallDelta({ argsFragment: ' 8, "rea' }),
  toolCallDelta({ argsFragment: 'son": "מתעניין בבירור' }),
  toolCallDelta({ argsFragment: '"}' }),
  done("tool_calls"),
  usage(200, 30),
  TERM,
].join("");

/** Two parallel tool calls in one response. */
export const PARALLEL_TOOL_CALLS = [
  toolCallDelta({ index: 0, id: "call_1", name: "score_lead" }),
  toolCallDelta({ index: 0, argsFragment: '{"score": 7, "reason": "ok"}' }),
  toolCallDelta({ index: 1, id: "call_2", name: "send_whatsapp" }),
  toolCallDelta({ index: 1, argsFragment: '{"message": "תודה!"}' }),
  done("tool_calls"),
  usage(180, 40),
  TERM,
].join("");

/** Tool call with malformed JSON args. */
export const TOOL_CALL_MALFORMED_ARGS = [
  toolCallDelta({ id: "call_x", name: "score_lead" }),
  toolCallDelta({ argsFragment: "{not_json" }),
  done("tool_calls"),
  TERM,
].join("");

/** Truncated response (length finish_reason). */
export const TRUNCATED_RESPONSE = [
  delta("התחלה של תשובה ארוכה ואז נחתך"),
  done("length"),
  TERM,
].join("");

/** Pure-text response with no trailing whitespace after the final period. */
export const NO_TRAILING_WS = [
  delta("שלום."),
  done("stop"),
  TERM,
].join("");

/** Mid-stream connection drop (no [DONE], no done event). */
export const MID_STREAM_DROP = [
  delta("התחלתי "),
  delta("לכתוב משהו ואז "),
  // ...stream just ends here.
].join("");
