/**
 * Normalize an Israeli phone number to 972 international format.
 * Accepts: 0501234567, 050-123-4567, +972501234567, 972501234567
 * Returns: "972501234567" or null if invalid.
 */
export function normalizeIsraeliPhone(raw: string): string | null {
  // Strip all non-digit characters
  const digits = raw.replace(/\D/g, "");

  let normalized: string;

  if (digits.startsWith("972")) {
    normalized = digits;
  } else if (digits.startsWith("0")) {
    normalized = "972" + digits.slice(1);
  } else {
    return null;
  }

  // Israeli mobile: 972 + 2 digit prefix (50-58, 71-79) + 7 digits = 12 digits total
  // Israeli landline: 972 + 1 digit area (2-9) + 7 digits = 11 digits total
  if (normalized.length === 12 || normalized.length === 11) {
    return normalized;
  }

  return null;
}

/**
 * Validate that a string is a valid Israeli phone number.
 */
export function isValidIsraeliPhone(raw: string): boolean {
  return normalizeIsraeliPhone(raw) !== null;
}

/**
 * Format a normalized phone number for display (e.g., "972501234567" -> "050-123-4567").
 */
export function formatPhoneDisplay(normalized: string): string {
  // Convert back to local format
  const local = "0" + normalized.slice(3);
  if (local.length === 10) {
    return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
  }
  if (local.length === 9) {
    return `${local.slice(0, 2)}-${local.slice(2, 5)}-${local.slice(5)}`;
  }
  return local;
}
