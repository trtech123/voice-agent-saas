// apps/voice-engine/src/worker.ts
import { Worker, Queue, type Job } from "bullmq";
import { createSupabaseAdmin } from "@vam/database";
import { config } from "./config.js";
import { processCallJob, handleDeadLetter } from "./call-processor.js";

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

/**
 * Enqueue a call job.
 * Campaign-scoped concurrency is enforced at the processor level
 * by checking active bridge count per campaign before starting a call.
 */
export async function enqueueCallJob(
  queue: Queue<CallJobData>,
  data: CallJobData,
  options?: {
    delay?: number;
  }
): Promise<void> {
  await queue.add(`call:${data.campaignId}`, data, {
    delay: options?.delay,
  });
}

export function createCallWorker(
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    child: (bindings: Record<string, unknown>) => any;
  },
  concurrency = 10
) {
  const worker = new Worker<CallJobData>(
    CALL_QUEUE_NAME,
    async (job: Job<CallJobData>) => {
      await processCallJob(job, log);
    },
    {
      connection: redisConnection,
      concurrency,
    }
  );

  worker.on("failed", async (job, err) => {
    if (job) {
      log.error({ jobId: job.id, error: err.message }, "Call job failed permanently");
      await handleDeadLetter(job.data, err.message, log);
    }
  });

  worker.on("error", (err) => {
    log.error({ error: err.message }, "Call worker error");
  });

  return worker;
}

export function createMonthlyResetScheduler() {
  const queue = new Queue(MONTHLY_RESET_QUEUE_NAME, { connection: redisConnection });

  // Add repeatable job: 1st of each month at 00:00 IST (UTC+2/+3)
  queue.upsertJobScheduler(
    "monthly-reset",
    { pattern: "0 0 1 * *" },
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
