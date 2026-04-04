// apps/voice-engine/src/schedule.ts

/**
 * Schedule enforcement module.
 *
 * Validates call timing against campaign schedule_windows and schedule_days.
 * All time comparisons use the Asia/Jerusalem timezone.
 * Saturday (Shabbat) is always blocked, regardless of schedule_days.
 */

export const ISRAEL_TZ = "Asia/Jerusalem";

// Day name to JS getDay() mapping (0=Sun, 1=Mon, ..., 6=Sat)
const DAY_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface ScheduleWindow {
  start: string; // "HH:mm" format
  end: string;   // "HH:mm" format
}

export interface ScheduleCheckResult {
  allowed: boolean;
  reason?: string;
  /** If not allowed, when is the next valid window (UTC Date)? */
  nextWindowAt?: Date;
}

/**
 * Get the current hour and minute in Israel timezone.
 * Uses Intl.DateTimeFormat to avoid heavy date library dependencies for this core path.
 */
function getIsraelTime(now: Date = new Date()): {
  hours: number;
  minutes: number;
  dayOfWeek: number;
  dayName: string;
} {
  // Format parts in Israel timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ISRAEL_TZ,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour");
  const minutePart = parts.find((p) => p.type === "minute");
  const weekdayPart = parts.find((p) => p.type === "weekday");

  const hours = parseInt(hourPart?.value ?? "0", 10);
  const minutes = parseInt(minutePart?.value ?? "0", 10);

  // Map short weekday name to day index
  const weekdayStr = (weekdayPart?.value ?? "Sun").toLowerCase().slice(0, 3);
  const dayOfWeek = DAY_MAP[weekdayStr] ?? 0;
  const dayName = DAY_NAMES[dayOfWeek];

  return { hours, minutes, dayOfWeek, dayName };
}

/**
 * Parse "HH:mm" string to total minutes since midnight.
 */
function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Check if the current time (Israel TZ) falls within any of the schedule windows
 * on a scheduled day. Saturday is always blocked (Shabbat).
 */
export function isWithinSchedule(
  windows: ScheduleWindow[],
  scheduleDays: string[],
  now: Date = new Date()
): ScheduleCheckResult {
  const israel = getIsraelTime(now);

  // Rule 1: Shabbat is always blocked
  if (israel.dayOfWeek === 6) {
    return {
      allowed: false,
      reason: "Shabbat — no calls allowed on Saturday",
    };
  }

  // Rule 2: Check if today is a scheduled day
  if (!scheduleDays.includes(israel.dayName)) {
    return {
      allowed: false,
      reason: `${israel.dayName} is not a scheduled day (allowed: ${scheduleDays.join(", ")})`,
    };
  }

  // Rule 3: Check if current time is within any window
  const currentMinutes = israel.hours * 60 + israel.minutes;

  for (const window of windows) {
    const startMinutes = parseTimeToMinutes(window.start);
    const endMinutes = parseTimeToMinutes(window.end);

    // start is inclusive, end is exclusive
    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `Current time ${String(israel.hours).padStart(2, "0")}:${String(israel.minutes).padStart(2, "0")} (Israel) is outside schedule windows`,
  };
}

/**
 * Find the next valid schedule window start time as a UTC Date.
 * Looks up to 7 days ahead. Returns null if no valid window found.
 */
export function getNextScheduleWindow(
  windows: ScheduleWindow[],
  scheduleDays: string[],
  now: Date = new Date()
): Date | null {
  const israel = getIsraelTime(now);
  const currentMinutes = israel.hours * 60 + israel.minutes;

  // Sort windows by start time
  const sorted = [...windows].sort(
    (a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start)
  );

  // Check remaining windows today
  if (scheduleDays.includes(israel.dayName) && israel.dayOfWeek !== 6) {
    for (const window of sorted) {
      const startMinutes = parseTimeToMinutes(window.start);
      if (startMinutes > currentMinutes) {
        // This window hasn't started yet today
        const diffMinutes = startMinutes - currentMinutes;
        return new Date(now.getTime() + diffMinutes * 60 * 1000);
      }
    }
  }

  // Check subsequent days (up to 7)
  for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
    const futureDate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const futureIsrael = getIsraelTime(futureDate);

    // Skip Shabbat
    if (futureIsrael.dayOfWeek === 6) continue;

    // Skip non-scheduled days
    if (!scheduleDays.includes(futureIsrael.dayName)) continue;

    // Return the first window start on this day
    if (sorted.length > 0) {
      const firstWindowStart = parseTimeToMinutes(sorted[0].start);
      // Calculate how many minutes from current Israel time to that future window
      const futureMinutes = futureIsrael.hours * 60 + futureIsrael.minutes;
      const diffMinutes = firstWindowStart - futureMinutes;
      return new Date(futureDate.getTime() + diffMinutes * 60 * 1000);
    }
  }

  return null;
}
