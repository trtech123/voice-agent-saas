#!/usr/bin/env node
// voiceagent-saas/scripts/migrate-campaign-to-unbundled.js
//
// Atomic per-campaign migration from EL Convai to unbundled voice pipeline.
// Steps performed:
//   1. Fetch the EL agent's prompt.prompt and first_message via the EL API
//   2. Print a dry-run diff
//   3. With --apply: write campaigns.system_prompt + first_message + voice_pipeline='unbundled'
//
// Idempotent: refuses to overwrite a non-null system_prompt unless --force.
//
// Usage:
//   node scripts/migrate-campaign-to-unbundled.js <campaign_id>
//   node scripts/migrate-campaign-to-unbundled.js <campaign_id> --apply
//   node scripts/migrate-campaign-to-unbundled.js <campaign_id> --apply --force
//
// Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §6.2

import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const campaignId = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const force = args.includes("--force");

if (!campaignId) {
  console.error("usage: migrate-campaign-to-unbundled.js <campaign_id> [--apply] [--force]");
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EL_KEY = process.env.ELEVENLABS_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars required");
  process.exit(1);
}
if (!EL_KEY) {
  console.error("ELEVENLABS_API_KEY env var required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  // 1. Load campaign
  const { data: campaign, error: cErr } = await supabase
    .from("campaigns")
    .select("id, name, elevenlabs_agent_id, system_prompt, first_message, voice_pipeline")
    .eq("id", campaignId)
    .single();
  if (cErr || !campaign) {
    console.error("campaign load failed:", cErr?.message || "not found");
    process.exit(1);
  }
  console.log("loaded campaign:", campaign.name, "agent:", campaign.elevenlabs_agent_id);

  // 2. Refuse if already migrated and not --force
  if (campaign.system_prompt && !force) {
    console.error(`campaign ${campaignId} already has system_prompt set. use --force to overwrite.`);
    process.exit(1);
  }

  // 3. Fetch the EL agent config
  const elRes = await fetch(
    `https://api.elevenlabs.io/v1/convai/agents/${campaign.elevenlabs_agent_id}`,
    { headers: { "xi-api-key": EL_KEY } },
  );
  if (!elRes.ok) {
    console.error("EL agent fetch failed:", elRes.status, await elRes.text());
    process.exit(1);
  }
  const elAgent = await elRes.json();
  const cc = elAgent.conversation_config;
  const systemPrompt = cc?.agent?.prompt?.prompt;
  const firstMessage = cc?.agent?.first_message;
  if (!systemPrompt || !firstMessage) {
    console.error("EL agent missing prompt.prompt or first_message — aborting");
    process.exit(1);
  }

  console.log();
  console.log("=== DIFF (dry run) ===");
  console.log("system_prompt:");
  console.log("  current:", JSON.stringify(campaign.system_prompt)?.slice(0, 80) || "(null)");
  console.log("  new:    ", JSON.stringify(systemPrompt).slice(0, 80) + "...");
  console.log("first_message:");
  console.log("  current:", JSON.stringify(campaign.first_message)?.slice(0, 80) || "(null)");
  console.log("  new:    ", JSON.stringify(firstMessage).slice(0, 80));
  console.log("voice_pipeline:");
  console.log("  current:", campaign.voice_pipeline ?? "(null = use tenant default)");
  console.log("  new:    ", "unbundled");
  console.log();

  if (!apply) {
    console.log("dry-run only. re-run with --apply to commit.");
    return;
  }

  // 4. Apply
  const { error: uErr } = await supabase
    .from("campaigns")
    .update({
      system_prompt: systemPrompt,
      first_message: firstMessage,
      voice_pipeline: "unbundled",
    })
    .eq("id", campaignId);

  if (uErr) {
    console.error("update failed:", uErr.message);
    process.exit(1);
  }

  console.log(`✓ campaign ${campaignId} migrated to unbundled pipeline.`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
