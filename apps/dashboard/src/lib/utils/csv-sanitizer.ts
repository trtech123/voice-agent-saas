import { normalizeIsraeliPhone } from "./phone-validator";

/** Maximum upload file size: 10MB */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Characters that indicate an Excel formula injection */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export interface RawContactRow {
  phone: string;
  name?: string;
  email?: string;
  [key: string]: string | undefined;
}

export interface SanitizedContact {
  phone: string;
  name: string | null;
  email: string | null;
  custom_fields: Record<string, string>;
}

export interface SanitizationResult {
  contacts: SanitizedContact[];
  errors: Array<{ row: number; reason: string }>;
  duplicatesRemoved: number;
  totalRows: number;
}

/**
 * Strip potential formula injection from a cell value.
 * Removes leading characters that Excel/Sheets interpret as formulas.
 */
function stripFormula(value: string): string {
  let cleaned = value.trim();
  while (cleaned.length > 0 && FORMULA_PREFIXES.includes(cleaned[0])) {
    cleaned = cleaned.slice(1).trim();
  }
  return cleaned;
}

/**
 * Parse CSV text content into rows.
 * Handles quoted fields and newlines within quotes.
 */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let current = "";
  let inQuotes = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        current += '"';
        i++; // skip escaped quote
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(current);
        current = "";
      } else if (char === "\n" || (char === "\r" && next === "\n")) {
        row.push(current);
        current = "";
        if (row.some((cell) => cell.trim() !== "")) {
          rows.push(row);
        }
        row = [];
        if (char === "\r") i++; // skip \n after \r
      } else {
        current += char;
      }
    }
  }

  // Last row
  row.push(current);
  if (row.some((cell) => cell.trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

/**
 * Sanitize parsed CSV rows into contacts.
 * - Strips formulas from all cells
 * - Validates phone format
 * - Deduplicates by phone
 * - Extracts known columns (phone, name, email) and puts the rest in custom_fields
 */
export function sanitizeContacts(
  rows: string[][],
  headerRow: string[]
): SanitizationResult {
  const errors: Array<{ row: number; reason: string }> = [];
  const seenPhones = new Set<string>();
  const contacts: SanitizedContact[] = [];
  let duplicatesRemoved = 0;

  // Normalize headers
  const headers = headerRow.map((h) => stripFormula(h).toLowerCase().trim());
  const phoneIdx = headers.findIndex((h) =>
    ["phone", "טלפון", "tel", "mobile", "נייד"].includes(h)
  );
  const nameIdx = headers.findIndex((h) =>
    ["name", "שם", "full_name", "שם מלא"].includes(h)
  );
  const emailIdx = headers.findIndex((h) =>
    ["email", "אימייל", "mail", 'דוא"ל'].includes(h)
  );

  if (phoneIdx === -1) {
    errors.push({ row: 0, reason: "חסרה עמודת טלפון בכותרת (phone / טלפון)" });
    return { contacts: [], errors, duplicatesRemoved: 0, totalRows: rows.length };
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +2 for 1-indexed and header row

    // Strip formulas from every cell
    const cleanRow = row.map(stripFormula);

    const rawPhone = cleanRow[phoneIdx] ?? "";
    const normalized = normalizeIsraeliPhone(rawPhone);

    if (!normalized) {
      errors.push({ row: rowNum, reason: `מספר טלפון לא תקין: "${rawPhone}"` });
      continue;
    }

    // Dedup by phone
    if (seenPhones.has(normalized)) {
      duplicatesRemoved++;
      continue;
    }
    seenPhones.add(normalized);

    // Extract known fields
    const name = nameIdx >= 0 ? (cleanRow[nameIdx] || null) : null;
    const email = emailIdx >= 0 ? (cleanRow[emailIdx] || null) : null;

    // Build custom_fields from remaining columns
    const custom_fields: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      if (j === phoneIdx || j === nameIdx || j === emailIdx) continue;
      const header = headers[j];
      const value = cleanRow[j];
      if (header && value) {
        custom_fields[header] = value;
      }
    }

    contacts.push({ phone: normalized, name, email, custom_fields });
  }

  return {
    contacts,
    errors,
    duplicatesRemoved,
    totalRows: rows.length,
  };
}
