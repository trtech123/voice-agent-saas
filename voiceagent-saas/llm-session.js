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
// by optional whitespace.
const SENTENCE_BOUNDARY = /[.!?،؟]\s*$/u;

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
    // Filled in by Task 4.
    yield { type: "done", fullText: "", totalTokensIn: 0, totalTokensOut: 0 };
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
