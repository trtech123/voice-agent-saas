// voiceagent-saas/elevenlabs-tools-adapter.js

/**
 * ElevenLabs client-tool adapter.
 *
 * Converts the vendor-clean tool schema defined in `tools.js` into the
 * ElevenLabs Conversational AI "client tool" JSON shape used when creating
 * or updating an EL agent via REST (see agent-sync-processor.js, T6).
 *
 * This adapter exists so `tools.js` stays vendor-neutral — it owns tool
 * names, descriptions, parameters, and implementations, and knows nothing
 * about ElevenLabs or Gemini. All vendor-specific schema translation lives
 * here (EL) or in the Gemini builder (to be removed in T10).
 *
 * Per Appendix A of the 2026-04-07 ElevenLabs runtime swap plan, the EL
 * tool definition shape is:
 *   { tool_name, description, parameters }
 *
 * All tools emitted by this adapter are intended to be marked
 * "blocking conversation" in the create-agent payload by the caller — every
 * Spec A tool has side effects.
 */

import { buildToolDefinitions } from "./tools.js";

/**
 * Build the EL client-tool array from the canonical tool schemas in tools.js.
 * @returns {Array<{tool_name: string, description: string, parameters: object}>}
 */
export function buildElevenLabsClientTools() {
  const gemini = buildToolDefinitions();
  const decls = (gemini && gemini.functionDeclarations) || [];

  // All Spec A tools are side-effect-bearing → blocking (post_tool_speech).
  return decls.map((decl) => ({
    type: "client_tool",
    name: decl.name,
    description: decl.description,
    parameters: decl.parameters,
    execution_mode: "post_tool_speech",
  }));
}
