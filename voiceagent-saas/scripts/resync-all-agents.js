#!/usr/bin/env node
// voiceagent-saas/scripts/resync-all-agents.js
//
// Bulk re-push corrected agent configs to ElevenLabs for all campaigns
// that have an elevenlabs_agent_id.
//
// Usage:
//   ELEVENLABS_API_KEY=... node scripts/resync-all-agents.js            # dry run
//   ELEVENLABS_API_KEY=... node scripts/resync-all-agents.js --apply    # actually sync
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env (or .env file).

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const EL_BASE = "https://api.elevenlabs.io";
const THROTTLE_MS = 500;
const HTTP_TIMEOUT_MS = 15_000;

function loadEnv() {
  try {
    const content = readFileSync(resolve(import.meta.dirname, "..", ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}

function buildElevenLabsClientTools(tools) {
  return tools.map((t) => ({
    type: "client",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    expects_response: true,
    execution_mode: "post_tool_speech",
  }));
}

function buildToolDefinitions() {
  const TOOL_NAMES = [
    "score_lead",
    "send_whatsapp",
    "request_callback",
    "mark_opt_out",
    "end_call",
  ];
  return TOOL_NAMES.map((name) => ({
    name,
    description: `Tool: ${name}`,
    parameters: { type: "object", properties: {}, required: [] },
  }));
}

function buildAgentPayload(row) {
  const tools = buildElevenLabsClientTools(buildToolDefinitions());
  const agent = {
    prompt: {
      prompt: row.script || "",
      tools,
    },
    language: "he",
  };
  return {
    name: `campaign-${row.id}`,
    conversation_config: {
      agent,
      tts: {
        voice_id: row.voice_id,
        model_id: row.tts_model || "eleven_turbo_v2_5",
      },
    },
  };
}

async function elFetch(method, url, { body, apiKey }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const init = {
      method,
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      signal: controller.signal,
    };
    if (body) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  loadEnv();

  const apply = process.argv.includes("--apply");
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey) {
    console.error("ELEVENLABS_API_KEY env var required");
    process.exit(1);
  }
  if (!supabaseUrl || !supabaseKey) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars required");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: campaigns, error } = await supabase
    .from("campaigns")
    .select("id, name, elevenlabs_agent_id, script, voice_id, tts_model")
    .not("elevenlabs_agent_id", "is", null);

  if (error) {
    console.error("Failed to query campaigns:", error.message);
    process.exit(1);
  }

  if (!campaigns || campaigns.length === 0) {
    console.log("No campaigns with elevenlabs_agent_id found.");
    return;
  }

  console.log(`Found ${campaigns.length} campaign(s) to sync.`);
  console.log(apply ? "Mode: APPLY" : "Mode: DRY RUN");
  console.log("---");

  let synced = 0;
  let failed = 0;

  for (const row of campaigns) {
    const payload = buildAgentPayload(row);
    const toolCount = payload.conversation_config.agent.prompt.tools.length;
    const toolNames = payload.conversation_config.agent.prompt.tools.map((t) => t.name).join(", ");

    if (!apply) {
      console.log(
        `[DRY RUN] campaign=${row.id} agent=${row.elevenlabs_agent_id} tools=[${toolNames}] (${toolCount})`
      );
      synced++;
      continue;
    }

    const url = `${EL_BASE}/v1/convai/agents/${row.elevenlabs_agent_id}`;
    try {
      const res = await elFetch("PATCH", url, { body: payload, apiKey });
      if (!res.ok) {
        const body = await res.text();
        console.error(
          `[FAIL] campaign=${row.id} agent=${row.elevenlabs_agent_id} status=${res.status} body=${body.slice(0, 200)}`
        );
        failed++;
      } else {
        console.log(
          `[OK] campaign=${row.id} agent=${row.elevenlabs_agent_id} tools=[${toolNames}] (${toolCount})`
        );
        synced++;
      }
    } catch (err) {
      console.error(
        `[FAIL] campaign=${row.id} agent=${row.elevenlabs_agent_id} error=${err.message}`
      );
      failed++;
    }

    await sleep(THROTTLE_MS);
  }

  console.log("---");
  console.log(`Done. synced=${synced} failed=${failed} total=${campaigns.length}`);
  if (!apply) console.log("Run with --apply to actually sync.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
