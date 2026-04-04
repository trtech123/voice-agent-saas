// apps/voice-engine/src/worker.ts
import { Worker, Queue } from "bullmq";
import { createSupabaseAdmin } from "@vam/database";
import { config } from "./config.js";

export const CALL_QUEUE_NAME = "call-jobs";
export const MONTHLY_RESET_QUEUE_NAME = "monthly-reset";

const redisConnection = { url: config.redisUrl };

export interface CallJobData {
  tenantId: string;
  campaignId: string;
  contactId: string;
  campaignContactId: string;
}

export function createCallQueue() {
  return new Queue<CallJobData>(CALL_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 1, // Retries handled at the campaign-contact level, not BullMQ
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
}

export function createCallWorker(concurrency = 10) {
  const db = createSupabaseAdmin(config.supabaseUrl, config.supabaseServiceRoleKey);

  const worker = new Worker<CallJobData>(
    CALL_QUEUE_NAME,
    async (job) => {
      const { tenantId, campaignId, contactId, campaignContactId } = job.data;
      console.log(`[call-worker] Processing call job: tenant=${tenantId} campaign=${campaignId} contact=${contactId}`);

      // Placeholder — Phase 2 will implement the full call flow:
      // 1. Validate DNC, schedule, call limit
      // 2. Initiate Voicenter call
      // 3. Bridge audio to Gemini Live
      // 4. Process results
      // For now, just log and mark as completed
      console.log(`[call-worker] Call job completed (placeholder): ${job.id}`);
    },
    {
      connection: redisConnection,
      concurrency,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[call-worker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

export function createMonthlyResetScheduler() {
  const queue = new Queue(MONTHLY_RESET_QUEUE_NAME, { connection: redisConnection });

  // Add repeatable job: 1st of each month at 00:00 IST (UTC+2/+3)
  queue.upsertJobScheduler(
    "monthly-reset",
    { pattern: "0 0 1 * *" }, // cron: midnight on 1st of month
    {
      name: "reset-monthly-usage",
      data: {},
    }
  );

  const worker = new Worker(
    MONTHLY_RESET_QUEUE_NAME,
    async () => {
      const db = createSupabaseAdmin(config.supabaseUrl, config.supabaseServiceRoleKey);
      const { error } = await db.rpc("reset_monthly_usage");
      if (error) {
        console.error("[monthly-reset] Failed to reset usage:", error);
        throw error;
      }
      console.log("[monthly-reset] Monthly call usage reset completed");
    },
    { connection: redisConnection }
  );

  return { queue, worker };
}
