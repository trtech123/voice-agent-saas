import { config } from "dotenv";
config();
import { Queue } from "bullmq";

const q = new Queue("call-jobs", { connection: { url: process.env.REDIS_URL } });
const j = await q.add("call", {
  tenantId: "fd278f50-4e2e-4de3-872d-015c1bd7ee95",
  campaignId: "22222222-2222-2222-2222-222222222222",
  contactId: "33333333-3333-3333-3333-333333333333",
  campaignContactId: "44444444-4444-4444-4444-444444444444",
});
console.log("Job:", j.id);
process.exit(0);
