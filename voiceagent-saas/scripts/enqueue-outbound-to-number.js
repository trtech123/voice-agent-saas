#!/usr/bin/env node
// Sets contacts.phone for the test contact, then enqueues a call job.
// Usage: node scripts/enqueue-outbound-to-number.js <phone>
// Optional env overrides: TEST_TENANT_ID, TEST_CAMPAIGN_ID, TEST_CONTACT_ID, TEST_CAMPAIGN_CONTACT_ID

import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createClient } from "@supabase/supabase-js";
import { Queue } from "bullmq";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

const phone = process.argv[2];
if (!phone) {
  console.error("Usage: node scripts/enqueue-outbound-to-number.js <phone>");
  process.exit(1);
}

const tenantId = process.env.TEST_TENANT_ID || "fd278f50-4e2e-4de3-872d-015c1bd7ee95";
const campaignId = process.env.TEST_CAMPAIGN_ID || "22222222-2222-2222-2222-222222222222";
const contactId = process.env.TEST_CONTACT_ID || "33333333-3333-3333-3333-333333333333";
const campaignContactId =
  process.env.TEST_CAMPAIGN_CONTACT_ID || "44444444-4444-4444-4444-444444444444";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const redisUrl = process.env.REDIS_URL;
if (!url || !key || !redisUrl) {
  console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or REDIS_URL");
  process.exit(1);
}

const sb = createClient(url, key);
const { error: uErr } = await sb
  .from("contacts")
  .update({ phone })
  .eq("id", contactId)
  .eq("tenant_id", tenantId);

if (uErr) {
  console.error("Failed to update contact phone:", uErr.message);
  process.exit(1);
}
console.log("Updated contact phone for", contactId);

const q = new Queue("call-jobs", { connection: { url: redisUrl } });
const j = await q.add("call", {
  tenantId,
  campaignId,
  contactId,
  campaignContactId,
});
console.log("Enqueued call job:", j.id);
await q.close();
process.exit(0);
