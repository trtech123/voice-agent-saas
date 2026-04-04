/**
 * Format a number with Hebrew locale (e.g., 1,234).
 */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat("he-IL").format(n);
}

/**
 * Format a date in Hebrew locale (e.g., "4 באפר׳ 2026").
 */
export function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(dateStr));
}

/**
 * Format a date with time (e.g., "4 באפר׳ 2026, 14:30").
 */
export function formatDateTime(dateStr: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(dateStr));
}

/**
 * Format call duration in minutes:seconds (e.g., "2:35").
 */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Hebrew labels for lead statuses.
 */
export const leadStatusLabels: Record<string, string> = {
  hot: "חם",
  warm: "חמים",
  cold: "קר",
  not_interested: "לא מעוניין",
  callback: "חזור אליו",
};

/**
 * Hebrew labels for campaign statuses.
 */
export const campaignStatusLabels: Record<string, string> = {
  draft: "טיוטה",
  active: "פעיל",
  paused: "מושהה",
  completed: "הושלם",
};

/**
 * Hebrew labels for contact statuses.
 */
export const contactStatusLabels: Record<string, string> = {
  pending: "ממתין",
  queued: "בתור",
  calling: "בשיחה",
  completed: "הושלם",
  failed: "נכשל",
  no_answer: "לא ענה",
  dnc: "חסום",
};

/**
 * Hebrew labels for call statuses.
 */
export const callStatusLabels: Record<string, string> = {
  initiated: "יזום",
  ringing: "מצלצל",
  connected: "מחובר",
  completed: "הושלם",
  failed: "נכשל",
  no_answer: "לא ענה",
  dead_letter: "נכשל סופית",
};

/**
 * Hebrew day name mapping.
 */
export const dayLabels: Record<string, string> = {
  sun: "ראשון",
  mon: "שני",
  tue: "שלישי",
  wed: "רביעי",
  thu: "חמישי",
  fri: "שישי",
  sat: "שבת",
};
