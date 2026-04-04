// apps/voice-engine/tests/schedule.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isWithinSchedule,
  getNextScheduleWindow,
  ISRAEL_TZ,
} from "../src/schedule.js";

// Helper: create a Date at a specific Israel time
function israelDate(isoWithOffset: string): Date {
  return new Date(isoWithOffset);
}

describe("schedule enforcement", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isWithinSchedule", () => {
    const defaultWindows = [
      { start: "10:00", end: "13:00" },
      { start: "16:00", end: "19:00" },
    ];
    const defaultDays = ["sun", "mon", "tue", "wed", "thu"];

    it("returns allowed=true during a valid window on a valid day", () => {
      // Wednesday 2026-04-08 at 11:00 Israel time (UTC+03:00 in April = IDT)
      vi.setSystemTime(new Date("2026-04-08T08:00:00.000Z")); // 11:00 IDT
      const result = isWithinSchedule(defaultWindows, defaultDays);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("returns allowed=false between windows", () => {
      // Wednesday 2026-04-08 at 14:00 Israel time
      vi.setSystemTime(new Date("2026-04-08T11:00:00.000Z")); // 14:00 IDT
      const result = isWithinSchedule(defaultWindows, defaultDays);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside schedule windows");
    });

    it("returns allowed=false on Saturday (Shabbat) regardless of schedule_days", () => {
      // Saturday 2026-04-11 at 11:00 Israel time
      vi.setSystemTime(new Date("2026-04-11T08:00:00.000Z")); // 11:00 IDT Saturday
      const result = isWithinSchedule(defaultWindows, [...defaultDays, "sat"]);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Shabbat");
    });

    it("returns allowed=false on Friday when Friday not in schedule_days", () => {
      // Friday 2026-04-10 at 11:00 Israel time
      vi.setSystemTime(new Date("2026-04-10T08:00:00.000Z")); // 11:00 IDT Friday
      const result = isWithinSchedule(defaultWindows, defaultDays);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not a scheduled day");
    });

    it("returns allowed=true on Friday when Friday is in schedule_days", () => {
      // Friday 2026-04-10 at 11:00 Israel time
      vi.setSystemTime(new Date("2026-04-10T08:00:00.000Z"));
      const result = isWithinSchedule(defaultWindows, [...defaultDays, "fri"]);
      expect(result.allowed).toBe(true);
    });

    it("returns allowed=true at exact start of window", () => {
      // Wednesday 2026-04-08 at 10:00 Israel time
      vi.setSystemTime(new Date("2026-04-08T07:00:00.000Z")); // 10:00 IDT
      const result = isWithinSchedule(defaultWindows, defaultDays);
      expect(result.allowed).toBe(true);
    });

    it("returns allowed=false at exact end of window", () => {
      // Wednesday 2026-04-08 at 13:00 Israel time
      vi.setSystemTime(new Date("2026-04-08T10:00:00.000Z")); // 13:00 IDT
      const result = isWithinSchedule(defaultWindows, defaultDays);
      expect(result.allowed).toBe(false);
    });

    it("returns allowed=true during second window", () => {
      // Wednesday 2026-04-08 at 17:30 Israel time
      vi.setSystemTime(new Date("2026-04-08T14:30:00.000Z")); // 17:30 IDT
      const result = isWithinSchedule(defaultWindows, defaultDays);
      expect(result.allowed).toBe(true);
    });

    it("handles single window campaigns", () => {
      vi.setSystemTime(new Date("2026-04-08T08:00:00.000Z")); // 11:00 IDT Wed
      const result = isWithinSchedule([{ start: "10:00", end: "14:00" }], defaultDays);
      expect(result.allowed).toBe(true);
    });
  });

  describe("getNextScheduleWindow", () => {
    it("returns next window start when currently outside", () => {
      // Wednesday 2026-04-08 at 14:00 Israel time (between windows)
      vi.setSystemTime(new Date("2026-04-08T11:00:00.000Z"));
      const defaultWindows = [
        { start: "10:00", end: "13:00" },
        { start: "16:00", end: "19:00" },
      ];
      const defaultDays = ["sun", "mon", "tue", "wed", "thu"];
      const next = getNextScheduleWindow(defaultWindows, defaultDays);
      expect(next).not.toBeNull();
      // Should be 16:00 IDT same day = 13:00 UTC
      expect(next!.toISOString()).toBe("2026-04-08T13:00:00.000Z");
    });
  });
});
