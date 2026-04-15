import { describe, it, expect, vi } from "vitest";
import { executeToolCall } from "../tools.js";

describe("request_callback tool execution", () => {
  it("persists preferred_time and callback_timestamp while preserving prior answers", async () => {
    const update = vi.fn(async () => {});
    const getById = vi.fn(async () => ({
      qualification_answers: {
        budget: "10000",
      },
    }));
    const auditLog = vi.fn(async () => {});

    const context = {
      callId: "call-1",
      contactId: "contact-1",
      dal: {
        calls: {
          getById,
          update,
        },
        auditLog: {
          log: auditLog,
        },
      },
      log: {
        info: vi.fn(),
        error: vi.fn(),
      },
    };

    const result = await executeToolCall(
      "request_callback",
      {
        preferred_time: "מחר בבוקר",
        callback_timestamp: "2026-04-16T09:00:00Z",
      },
      context,
    );

    expect(result).toEqual({
      success: true,
      callback_requested: true,
      preferred_time: "מחר בבוקר",
      callback_timestamp: "2026-04-16T09:00:00Z",
    });
    expect(getById).toHaveBeenCalledWith("call-1");
    expect(update).toHaveBeenCalledWith("call-1", {
      lead_status: "callback",
      qualification_answers: {
        budget: "10000",
        callback_preferred_time: "מחר בבוקר",
        callback_timestamp: "2026-04-16T09:00:00Z",
      },
    });
    expect(auditLog).toHaveBeenCalledWith("callback_requested", "call", "call-1", {
      contactId: "contact-1",
      preferredTime: "מחר בבוקר",
      callbackTimestamp: "2026-04-16T09:00:00Z",
    });
  });

  it("still works when calls.getById is unavailable", async () => {
    const update = vi.fn(async () => {});

    const result = await executeToolCall(
      "request_callback",
      {
        preferred_time: "בעוד 5 דקות",
        callback_timestamp: "2026-04-16T10:05:00Z",
      },
      {
        callId: "call-2",
        contactId: "contact-2",
        dal: {
          calls: {
            update,
          },
          auditLog: {
            log: vi.fn(async () => {}),
          },
        },
        log: {
          info: vi.fn(),
          error: vi.fn(),
        },
      },
    );

    expect(result.success).toBe(true);
    expect(update).toHaveBeenCalledWith("call-2", {
      lead_status: "callback",
      qualification_answers: {
        callback_preferred_time: "בעוד 5 דקות",
        callback_timestamp: "2026-04-16T10:05:00Z",
      },
    });
  });
});
