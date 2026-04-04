// apps/voice-engine/tests/call-processor.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isWithinScheduleWindows,
  isScheduleDay,
  validateCallPreconditions,
} from "../src/call-processor.js";

describe("isScheduleDay", () => {
  it("returns true for Sunday when schedule includes sun", () => {
    // 2026-04-05 is a Sunday
    const result = isScheduleDay(
      ["sun", "mon", "tue", "wed", "thu"],
      new Date("2026-04-05T10:00:00+03:00")
    );
    expect(result).toBe(true);
  });

  it("returns false for Saturday (Shabbat)", () => {
    // 2026-04-04 is a Saturday
    const result = isScheduleDay(
      ["sun", "mon", "tue", "wed", "thu"],
      new Date("2026-04-04T10:00:00+03:00")
    );
    expect(result).toBe(false);
  });

  it("returns false for Friday when not in schedule", () => {
    const result = isScheduleDay(
      ["sun", "mon", "tue", "wed", "thu"],
      new Date("2026-04-10T10:00:00+03:00") // Friday
    );
    expect(result).toBe(false);
  });
});

describe("isWithinScheduleWindows", () => {
  it("returns true when current time is within a window", () => {
    const windows = [
      { start: "10:00", end: "13:00" },
      { start: "16:00", end: "19:00" },
    ];
    // 11:00 IST is within 10:00-13:00
    const result = isWithinScheduleWindows(
      windows,
      new Date("2026-04-05T08:00:00Z") // 11:00 IST (UTC+3)
    );
    expect(result).toBe(true);
  });

  it("returns true for the second window", () => {
    const windows = [
      { start: "10:00", end: "13:00" },
      { start: "16:00", end: "19:00" },
    ];
    // 17:00 IST
    const result = isWithinScheduleWindows(
      windows,
      new Date("2026-04-05T14:00:00Z") // 17:00 IST
    );
    expect(result).toBe(true);
  });

  it("returns false between windows", () => {
    const windows = [
      { start: "10:00", end: "13:00" },
      { start: "16:00", end: "19:00" },
    ];
    // 14:00 IST — between windows
    const result = isWithinScheduleWindows(
      windows,
      new Date("2026-04-05T11:00:00Z") // 14:00 IST
    );
    expect(result).toBe(false);
  });

  it("returns false before first window", () => {
    const windows = [{ start: "10:00", end: "13:00" }];
    // 08:00 IST
    const result = isWithinScheduleWindows(
      windows,
      new Date("2026-04-05T05:00:00Z") // 08:00 IST
    );
    expect(result).toBe(false);
  });
});

describe("validateCallPreconditions", () => {
  const mockDal = {
    contacts: {
      isDnc: vi.fn(),
    },
    tenants: {
      isUnderCallLimit: vi.fn(),
    },
  };

  const baseCampaign = {
    schedule_days: ["sun", "mon", "tue", "wed", "thu"],
    schedule_windows: [
      { start: "10:00", end: "13:00" },
      { start: "16:00", end: "19:00" },
    ],
    status: "active" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDal.contacts.isDnc.mockResolvedValue(false);
    mockDal.tenants.isUnderCallLimit.mockResolvedValue(true);
  });

  it("passes when all conditions are met", async () => {
    const result = await validateCallPreconditions(
      "contact-1",
      baseCampaign,
      mockDal as any,
      new Date("2026-04-05T08:00:00Z") // Sunday 11:00 IST
    );
    expect(result).toEqual({ valid: true });
  });

  it("fails when contact is DNC", async () => {
    mockDal.contacts.isDnc.mockResolvedValue(true);
    const result = await validateCallPreconditions(
      "contact-1",
      baseCampaign,
      mockDal as any,
      new Date("2026-04-05T08:00:00Z")
    );
    expect(result).toEqual({ valid: false, reason: "contact_dnc" });
  });

  it("fails when over call limit", async () => {
    mockDal.tenants.isUnderCallLimit.mockResolvedValue(false);
    const result = await validateCallPreconditions(
      "contact-1",
      baseCampaign,
      mockDal as any,
      new Date("2026-04-05T08:00:00Z")
    );
    expect(result).toEqual({ valid: false, reason: "call_limit_exceeded" });
  });

  it("fails outside schedule windows", async () => {
    const result = await validateCallPreconditions(
      "contact-1",
      baseCampaign,
      mockDal as any,
      new Date("2026-04-05T05:00:00Z") // Sunday 08:00 IST — before 10:00
    );
    expect(result).toEqual({ valid: false, reason: "outside_schedule" });
  });

  it("fails on Shabbat", async () => {
    const result = await validateCallPreconditions(
      "contact-1",
      baseCampaign,
      mockDal as any,
      new Date("2026-04-04T08:00:00Z") // Saturday
    );
    expect(result).toEqual({ valid: false, reason: "outside_schedule" });
  });

  it("fails when campaign is not active", async () => {
    const result = await validateCallPreconditions(
      "contact-1",
      { ...baseCampaign, status: "paused" as const },
      mockDal as any,
      new Date("2026-04-05T08:00:00Z")
    );
    expect(result).toEqual({ valid: false, reason: "campaign_not_active" });
  });
});
