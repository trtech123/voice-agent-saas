import { describe, it, expect, vi, afterEach } from "vitest";
import { handleScheduleBlockedReschedule } from "../call-processor.js";

function createDb({ cc = { daily_retry_count: 0, last_retry_day: null }, failRollback = false } = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      return {
        select() {
          return this;
        },
        update(payload) {
          this.payload = payload;
          return this;
        },
        eq(field, value) {
          if (this.payload) {
            if (failRollback && this.payload.status === "needs_attention") {
              throw new Error("rollback failed");
            }
            updates.push({ table, payload: this.payload, field, value });
          }
          return this;
        },
        async single() {
          return { data: cc, error: null };
        },
      };
    },
  };
}

describe("handleScheduleBlockedReschedule", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reverts to needs_attention when delayed enqueue fails after marking queued", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T10:00:00Z"));
    const db = createDb();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleScheduleBlockedReschedule({
      db,
      log,
      job: { data: { id: "job-data" } },
      campaign: {
        id: "campaign-1",
        schedule_days: ["wed"],
        schedule_windows: [{ start: "14:00", end: "18:00" }],
      },
      campaignContactId: "cc-1",
      retryQueueName: "call-jobs",
      enqueueRetryFn: vi.fn(async () => { throw new Error("redis unavailable"); }),
    });

    expect(db.updates).toHaveLength(2);
    expect(db.updates[0].payload).toMatchObject({
      status: "queued",
      daily_retry_count: 1,
      last_retry_day: "2026-04-15",
    });
    expect(db.updates[1].payload).toMatchObject({
      status: "needs_attention",
      next_retry_at: null,
    });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignContactId: "cc-1" }),
      "Schedule reschedule enqueue failed after DB queued update; reverting status",
    );
  });

  it("logs manual reconciliation when rollback also fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T10:00:00Z"));
    const db = createDb({ failRollback: true });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleScheduleBlockedReschedule({
      db,
      log,
      job: {},
      campaign: {
        id: "campaign-1",
        schedule_days: ["wed"],
        schedule_windows: [{ start: "14:00", end: "18:00" }],
      },
      campaignContactId: "cc-1",
      retryQueueName: "call-jobs",
      enqueueRetryFn: vi.fn(async () => { throw new Error("redis unavailable"); }),
    });

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignContactId: "cc-1" }),
      "Schedule reschedule rollback failed; manual reconciliation required",
    );
  });
});
