import { describe, it, expect, vi } from "vitest";
import { finalizeInboundBridge } from "../inbound-finalizer.js";

function createDb({ failUpdates = false } = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      return {
        update(payload) {
          return {
            async eq(field, value) {
              if (failUpdates) throw new Error("db unavailable");
              updates.push({ table, payload, field, value });
              return { data: null, error: null };
            },
          };
        },
      };
    },
  };
}

describe("finalizeInboundBridge", () => {
  it("writes completed status and duration on successful bridge completion", async () => {
    const db = createDb();
    await finalizeInboundBridge({
      bridge: { start: vi.fn(async () => ({ duration_seconds: 42, failureReason: null })) },
      call: { callId: "call-1", sipCallId: "sip-1" },
      db,
      cleanupAsteriskResources: vi.fn(),
      log: { info: vi.fn(), error: vi.fn() },
    });

    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].payload).toMatchObject({
      status: "completed",
      duration_seconds: 42,
    });
    expect(db.updates[0]).toMatchObject({ table: "calls", field: "id", value: "call-1" });
  });

  it("writes failed status and failure reason when bridge reports a failure", async () => {
    const db = createDb();
    await finalizeInboundBridge({
      bridge: { start: vi.fn(async () => ({ duration_seconds: 5, failureReason: "network_error" })) },
      call: { callId: "call-2", sipCallId: "sip-2" },
      db,
      cleanupAsteriskResources: vi.fn(),
      log: { info: vi.fn(), error: vi.fn() },
    });

    expect(db.updates[0].payload).toMatchObject({
      status: "failed",
      duration_seconds: 5,
      failure_reason: "network_error",
      failure_reason_t: "network_error",
    });
  });

  it("catches finalization errors, attempts failed status write, and cleans Asterisk resources", async () => {
    const db = createDb();
    const cleanup = vi.fn(async () => {});
    const log = { info: vi.fn(), error: vi.fn() };

    await finalizeInboundBridge({
      bridge: { start: vi.fn(async () => { throw new Error("bridge exploded"); }) },
      call: { callId: "call-3", sipCallId: "sip-3" },
      db,
      cleanupAsteriskResources: cleanup,
      log,
    });

    expect(db.updates[0].payload).toMatchObject({
      status: "failed",
      failure_reason: "network_error",
      failure_reason_t: "network_error",
    });
    expect(cleanup).toHaveBeenCalledWith({ callId: "call-3", sipCallId: "sip-3" });
    expect(log.error).toHaveBeenCalled();
  });

  it("logs when both primary finalization and failed-status fallback write fail", async () => {
    const db = createDb({ failUpdates: true });
    const cleanup = vi.fn(async () => {});
    const log = { info: vi.fn(), error: vi.fn() };

    await finalizeInboundBridge({
      bridge: { start: vi.fn(async () => ({ duration_seconds: 1, failureReason: null })) },
      call: { callId: "call-4", sipCallId: "sip-4" },
      db,
      cleanupAsteriskResources: cleanup,
      log,
    });

    expect(cleanup).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-4", sipCallId: "sip-4" }),
      "Inbound failure status update failed; manual reconciliation required",
    );
  });
});
