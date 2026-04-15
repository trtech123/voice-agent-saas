import { config } from "dotenv";
config();
import { Queue } from "bullmq";

const q = new Queue("agent-sync-jobs", { connection: { url: process.env.REDIS_URL } });

const j = await q.add("agent-sync", {
  campaignId: "22222222-2222-2222-2222-222222222222",
  action: "create",
});

console.log("Job:", j.id);
process.exit(0);