// voiceagent-saas/llm-session.js
//
// OpenAI streaming chat completions adapter for the unbundled voice pipeline.
// Per-turn instance. NOT an EventEmitter — uses an async-generator-of-tagged-
// objects pattern so the orchestrator can drive the tool-call loop deterministically.
//
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §5.2, §4.3
//
// Lifecycle: one LLMSession per user turn commit. The orchestrator instantiates
// it, calls run(messages), iterates the async generator, and resolves any
// tool_call_request via provideToolResult().

import { Agent } from "undici";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

// Sentence boundary regex covering Latin and Hebrew/Arabic punctuation.
// Matches when the buffer ends with a sentence-terminating mark followed
// by at least one whitespace character (indicating the model has moved on
// to the next sentence). Terminal punctuation without trailing space only
// flushes at [DONE] or via the max-buffer-ms timer.
const SENTENCE_BOUNDARY = /[.!?،؟]\s+$/u;

const FIRST_ROUND_TIMEOUT_MS = 8000;
const TOTAL_ROUND_BUDGET_MS = 15000;
const MAX_TOOL_ROUNDS = 3;
const MAX_BUFFER_MS_NO_TOKENS = 200;
const MIN_SENTENCE_WORDS_AFTER_FIRST = 4;

class LLMSessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LLMSessionError";
    this.code = code;
  }
}

// ─── Shared HTTP/2 keepalive agent ───────────────────────────────────────
//
// One agent per Node process, shared across all LLMSession instances. Saves
// the TLS handshake on every call after the first. Initialized lazily so
// tests can construct the module without it.

let _sharedAgent = null;
function getOpenAIAgent() {
  if (_sharedAgent) return _sharedAgent;
  _sharedAgent = new Agent({
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connect: { rejectUnauthorized: true },
  });
  return _sharedAgent;
}

// Test hook: lets unit tests inject a fake fetch.
let _fetch = globalThis.fetch;
export function __setFetchForTests(fn) {
  _fetch = fn || globalThis.fetch;
}

export class LLMSession {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey - OpenAI API key
   * @param {object} opts.logger - pino-compatible
   * @param {string} [opts.model="gpt-4o-mini"]
   * @param {Array} [opts.toolSchema] - OpenAI function-calling schema (from buildOpenAIToolSchema)
   * @param {AbortSignal} [opts.abortSignal] - external abort (used by barge-in)
   * @param {number} [opts.maxTokens=200]
   */
  constructor({ apiKey, logger, model, toolSchema, abortSignal, maxTokens } = {}) {
    if (!apiKey) throw new Error("LLMSession: apiKey required");
    if (!logger) throw new Error("LLMSession: logger required");
    this.apiKey = apiKey;
    this.log = logger;
    this.model = model || DEFAULT_MODEL;
    this.toolSchema = toolSchema || [];
    this.abortSignal = abortSignal || null;
    this.maxTokens = maxTokens ?? 200;

    // Tool-call resolution coordination
    this._pendingToolResolvers = new Map();
    this._toolFailureCounts = new Map();
    this._totalTokensIn = 0;
    this._totalTokensOut = 0;
    this._roundCount = 0;
  }

  /**
   * Run a single LLM turn with the given conversation messages. Returns an
   * async generator yielding tagged objects:
   *
   *   { type: 'sentence', text }
   *   { type: 'tool_call_request', name, args, callId }
   *   { type: 'usage', tokens_in, tokens_out }
   *   { type: 'done', fullText, totalTokensIn, totalTokensOut }
   *
   * After yielding 'tool_call_request', the generator awaits provideToolResult(callId, result)
   * before continuing. The orchestrator (plan 5) drives this loop.
   */
  async *run(messages) {
    let workingMessages = [...messages];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      this._lastToolAcc = new Map();
      this._lastFinishReason = null;

      const forceNoTools = round >= MAX_TOOL_ROUNDS;
      const stream = await this._streamRound(workingMessages, forceNoTools);
      yield* this._iterateStream(stream);

      const toolAcc = this._lastToolAcc;
      const finishReason = this._lastFinishReason;
      if (finishReason !== "tool_calls" || toolAcc.size === 0) break;

      // Build assistant message that captures the model's tool_calls (required
      // by OpenAI to be present in history before the corresponding tool messages).
      const assistantMsg = { role: "assistant", content: null, tool_calls: [] };
      const toolResults = [];
      const realCalls = [];

      for (const [, acc] of toolAcc) {
        if (!acc.id || !acc.name) continue;
        assistantMsg.tool_calls.push({
          id: acc.id,
          type: "function",
          function: { name: acc.name, arguments: acc.argsText },
        });
        let parsed;
        try {
          parsed = JSON.parse(acc.argsText);
        } catch {
          toolResults.push({
            role: "tool",
            tool_call_id: acc.id,
            content: "tool args invalid, please retry",
          });
          continue;
        }
        realCalls.push({ id: acc.id, name: acc.name, args: parsed });
      }

      workingMessages = [...workingMessages, assistantMsg, ...toolResults];

      // Yield each real tool call and await its result, appending the result
      // to workingMessages as it arrives.
      for (const call of realCalls) {
        const resultPromise = new Promise((resolve) => {
          this._pendingToolResolvers.set(call.id, resolve);
        });
        yield { type: "tool_call_request", name: call.name, args: call.args, callId: call.id };
        const result = await resultPromise;
        workingMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
    }

    yield {
      type: "done",
      fullText: this._fullText,
      totalTokensIn: this._totalTokensIn,
      totalTokensOut: this._totalTokensOut,
    };
  }

  async _streamRound(messages, forceNoTools = false) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this._streamRoundOnce(messages, forceNoTools);
      } catch (err) {
        lastErr = err;
        const code = err.code;
        // Abort: never retry
        if (err.name === "AbortError") throw err;
        // Retry policy
        if (code === "llm_bad_request") throw err;          // 4xx (non-429): no retry
        if (attempt >= 2) throw err;                        // out of retries
        if (code === "llm_rate_limited") {
          // Honor retry-after if present
          const ra = err.retryAfterMs ?? 1000;
          await new Promise((r) => setTimeout(r, ra));
        } else if (code === "llm_failed") {
          // 5xx: exponential backoff
          await new Promise((r) => setTimeout(r, attempt === 0 ? 250 : 750));
        } else {
          // Network etc — single short retry then fail
          if (attempt >= 1) throw err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
    throw lastErr;
  }

  async _streamRoundOnce(messages, forceNoTools) {
    this._roundCount += 1;
    this._fullText = "";
    const body = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.maxTokens,
      temperature: 0,
    };
    if (this.toolSchema && this.toolSchema.length > 0) {
      body.tools = this.toolSchema;
      body.tool_choice = forceNoTools ? "none" : "auto";
    }
    const ac = new AbortController();
    if (this.abortSignal) {
      this.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    const res = await _fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new LLMSessionError(
        `OpenAI HTTP ${res.status}: ${text.slice(0, 200)}`,
        this._classifyHttpError(res.status),
      );
      err.status = res.status;
      // Parse retry-after if present
      const ra = res.headers.get("retry-after");
      if (ra) {
        const seconds = parseFloat(ra);
        if (!isNaN(seconds)) err.retryAfterMs = Math.min(2000, seconds * 1000);
      }
      throw err;
    }
    return res.body;
  }

  _classifyHttpError(status) {
    if (status === 429) return "llm_rate_limited";
    if (status >= 500) return "llm_failed";
    return "llm_bad_request";
  }

  /**
   * Async generator that consumes the OpenAI SSE stream and yields tagged
   * objects (sentence / tool_call_request / usage). Updates this._fullText,
   * this._totalTokensIn, this._totalTokensOut as a side-effect.
   */
  async *_iterateStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sentenceBuf = "";
    let firstSentenceEmitted = false;
    let lastTokenAt = Date.now();
    // Tool-call accumulator: index → { id, name, argsText }
    const toolAcc = new Map();
    let finishReason = null;

    const tryFlushSentence = (force = false) => {
      const text = sentenceBuf.trim();
      if (!text) return null;
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const hasBoundary = SENTENCE_BOUNDARY.test(sentenceBuf);
      if (force || hasBoundary) {
        // First sentence bypasses min-word check
        if (firstSentenceEmitted && !force && wordCount < MIN_SENTENCE_WORDS_AFTER_FIRST) {
          return null; // wait for more tokens
        }
        sentenceBuf = "";
        firstSentenceEmitted = true;
        return text;
      }
      return null;
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Process complete SSE events
        let nl;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const event = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (!event.startsWith("data: ")) continue;
          const payload = event.slice(6);
          if (payload === "[DONE]") {
            const flushed = tryFlushSentence(true);
            if (flushed) yield { type: "sentence", text: flushed };
            this._lastToolAcc = toolAcc;
            this._lastFinishReason = finishReason;
            return; // generator done
          }
          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          // Usage event (separate chunk per OpenAI's stream_options)
          if (json.usage) {
            this._totalTokensIn = json.usage.prompt_tokens || 0;
            this._totalTokensOut = json.usage.completion_tokens || 0;
            yield { type: "usage", tokens_in: this._totalTokensIn, tokens_out: this._totalTokensOut };
          }
          const choice = json.choices?.[0];
          if (!choice) continue;
          // Track finish_reason
          if (choice.finish_reason) finishReason = choice.finish_reason;
          // Content delta
          const contentDelta = choice.delta?.content;
          if (contentDelta) {
            sentenceBuf += contentDelta;
            this._fullText += contentDelta;
            lastTokenAt = Date.now();
            const flushed = tryFlushSentence(false);
            if (flushed) yield { type: "sentence", text: flushed };
          }
          // Tool-call deltas (Task 5 will yield these)
          const tcDeltas = choice.delta?.tool_calls;
          if (tcDeltas) {
            for (const tc of tcDeltas) {
              const idx = tc.index ?? 0;
              if (!toolAcc.has(idx)) {
                toolAcc.set(idx, { id: null, name: null, argsText: "" });
              }
              const acc = toolAcc.get(idx);
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.argsText += tc.function.arguments;
            }
          }
        }
        // Max-buffer-ms flush: if we haven't seen a token in 200ms AND have
        // a buffer, flush it as a sentence even without a boundary.
        if (Date.now() - lastTokenAt > MAX_BUFFER_MS_NO_TOKENS && sentenceBuf.trim()) {
          const flushed = tryFlushSentence(true);
          if (flushed) yield { type: "sentence", text: flushed };
        }
      }
      // Stream ended without [DONE] — flush whatever's left.
      const flushed = tryFlushSentence(true);
      if (flushed) yield { type: "sentence", text: flushed };
      // Stash tool calls + finish reason for the orchestrator (Task 5 wires this in).
      this._lastToolAcc = toolAcc;
      this._lastFinishReason = finishReason;
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  /**
   * Resolve an awaiting tool_call_request. Called by the orchestrator after
   * executing the tool.
   */
  provideToolResult(callId, result) {
    const resolver = this._pendingToolResolvers.get(callId);
    if (!resolver) {
      this.log.warn({ callId }, "provideToolResult: no pending resolver");
      return;
    }
    this._pendingToolResolvers.delete(callId);
    resolver(result);
  }
}

export { LLMSessionError, getOpenAIAgent };
