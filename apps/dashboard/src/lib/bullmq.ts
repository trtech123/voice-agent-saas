import { Queue } from "bullmq";

const CALL_QUEUE_NAME = "call-jobs";

let callQueue: Queue | null = null;

export interface CallJobData {
  tenantId: string;
  campaignId: string;
  contactId: string;
  campaignContactId: string;
}

/**
 * Get or create the BullMQ call queue.
 * Used by API routes to enqueue call jobs.
 */
export function getCallQueue(): Queue<CallJobData> {
  if (!callQueue) {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    callQueue = new Queue<CallJobData>(CALL_QUEUE_NAME, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return callQueue as Queue<CallJobData>;
}
