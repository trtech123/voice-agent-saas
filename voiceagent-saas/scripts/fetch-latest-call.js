#!/usr/bin/env node
/**
 * Fetch the most recent call row plus turns and tool invocations from Supabase.
 *
 * Usage (from voiceagent-saas/):
 *   node scripts/fetch-latest-call.js
 *   node scripts/fetch-latest-call.js <call_id>
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment.
 * Optional: DOTENV_CONFIG_PATH=/path/to/.env node scripts/fetch-latest-call.js
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const envPath = process.env.DOTENV_CONFIG_PATH;
if (envPath) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them or use DOTENV_CONFIG_PATH.",
  );
  process.exit(1);
}

const db = createClient(url, key);

function printJson(label, data) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const argCallId = process.argv[2];

  let callRow;
  if (argCallId) {
    const { data, error } = await db.from("calls").select("*").eq("id", argCallId).single();
    if (error) {
      console.error("Failed to load call:", error.message);
      process.exit(1);
    }
    callRow = data;
  } else {
    const { data, error } = await db
      .from("calls")
      .select("*")
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("Failed to fetch latest call:", error.message);
      process.exit(1);
    }
    if (!data) {
      console.error("No calls found.");
      process.exit(1);
    }
    callRow = data;
  }

  printJson("calls", callRow);
  const callId = callRow.id;
  const tenantId = callRow.tenant_id;

  const [{ data: turns, error: turnsErr }, { data: tools, error: toolsErr }, { data: metrics, error: metricsErr }] =
    await Promise.all([
      db
        .from("call_turns")
        .select("*")
        .eq("call_id", callId)
        .order("turn_index", { ascending: true }),
      db
        .from("call_tool_invocations")
        .select("*")
        .eq("call_id", callId)
        .order("started_at", { ascending: true }),
      db.from("call_metrics").select("*").eq("call_id", callId).maybeSingle(),
    ]);

  if (turnsErr) console.error("call_turns error:", turnsErr.message);
  else printJson("call_turns", turns ?? []);

  if (toolsErr) console.error("call_tool_invocations error:", toolsErr.message);
  else printJson("call_tool_invocations", tools ?? []);

  if (metricsErr) console.error("call_metrics error:", metricsErr.message);
  else printJson("call_metrics", metrics ?? null);

  const { data: auditSample, error: auditErr } = await db
    .from("audit_logs")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("resource_id", callId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (auditErr) {
    console.error("audit_logs sample error:", auditErr.message);
  } else {
    printJson("audit_logs (resource_id = call id)", auditSample ?? []);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
