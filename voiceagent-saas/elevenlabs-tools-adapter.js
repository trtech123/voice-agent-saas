// voiceagent-saas/elevenlabs-tools-adapter.js

/**
 * ElevenLabs client-tool adapter.
 *
 * Converts the vendor-clean tool schema defined in `tools.js` into the
 * ElevenLabs Conversational AI "client tool" JSON shape used when creating
 * or updating an EL agent via REST.
 */

import { TOOL_CATALOG } from "./tools.js";

/**
 * Build the EL client-tool array.
 * Note: We don't pass parameters - EL auto-generates from descriptions.
 */
export function buildElevenLabsClientTools() {
  return TOOL_CATALOG.map((entry) => ({
    type: "client",
    name: entry.name,
    description: entry.description,
    expects_response: true,
    execution_mode: "post_tool_speech",
  }));
}