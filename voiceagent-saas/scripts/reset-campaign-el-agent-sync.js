#!/usr/bin/env node
// voiceagent-saas/scripts/reset-campaign-el-agent-sync.js
//
// Clears local ElevenLabs agent id on a campaign and enqueues a fresh "create"
// agent-sync job (after code deploy with fixed buildAgentPayload).
//
// Usage:
//   REDIS_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node voiceagent-saas/scripts/reset-campaign-el-agent-sync.js <campaign_uuid>
//   node .../reset-campaign-el-agent-sync.js --by-agent-id <elevenlabs_agent_id>
//     (lookup works only while campaigns.elevenlabs_agent_id still matches EL)
//
// Loads voiceagent-saas/.env when present (dotenv).

import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createClient } from "@supabase/supabase-js";
import { Queue } from "bullmq";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

const argv = process.argv.slice(2);
const byAgentIdx = argv.indexOf("--by-agent-id");
const lookupAgentId =
  byAgentIdx >= 0 && argv[byAgentIdx + 1] ? argv[byAgentIdx + 1] : null;
const positionalArgs = argv.filter((a, i) => {
  if (a === "--by-agent-id") return false;
  if (i > 0 && argv[i - 1] === "--by-agent-id") return false;
  return !a.startsWith("-");
});
let campaignId = lookupAgentId ? null : positionalArgs[0] ?? null;

if (!lookupAgentId && !campaignId) {
  console.error(
    "Usage: node scripts/reset-campaign-el-agent-sync.js <campaign_uuid>\n" +
      "   or: node scripts/reset-campaign-el-agent-sync.js --by-agent-id <elevenlabs_agent_id>"
  );
  process.exit(1);
}

const redisUrl = process.env.REDIS_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!redisUrl || !supabaseUrl || !supabaseKey) {
  console.error("Missing REDIS_URL, SUPABASE_URL, or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

if (lookupAgentId) {
  const { data: rows, error: findErr } = await supabase
    .from("campaigns")
    .select("id, elevenlabs_agent_id")
    .eq("elevenlabs_agent_id", lookupAgentId)
    .limit(2);

  if (findErr) {
    console.error("Lookup failed:", findErr.message);
    process.exit(1);
  }
  if (!rows?.length) {
    console.error("No campaign found with elevenlabs_agent_id:", lookupAgentId);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error("Multiple campaigns share this agent id; pass campaign UUID explicitly.");
    process.exit(1);
  }
  campaignId = rows[0].id;
  console.log("Resolved campaign", campaignId, "for agent", lookupAgentId);
}

const { data: row, error: readErr } = await supabase
  .from("campaigns")
  .select("id, elevenlabs_agent_id")
  .eq("id", campaignId)
  .single();

if (readErr || !row) {
  console.error("Campaign not found:", readErr?.message);
  process.exit(1);
}

const { error: updErr } = await supabase
  .from("campaigns")
  .update({
    elevenlabs_agent_id: null,
    agent_status: "pending",
    agent_sync_error: null,
  })
  .eq("id", campaignId);

if (updErr) {
  console.error("Failed to clear agent fields:", updErr.message);
  process.exit(1);
}

console.log("Cleared elevenlabs_agent_id for campaign", campaignId);

const q = new Queue("agent-sync-jobs", { connection: { url: redisUrl } });
const job = await q.add(
  "agent-sync",
  { campaignId, action: "create" },
  // BullMQ forbids ":" in custom jobId; keep stable id for burst coalescing.
  { jobId: `agent-sync-${campaignId}`, delay: 2000 }
);

console.log("Enqueued agent-sync create job:", job.id);
await q.close();
process.exit(0);
