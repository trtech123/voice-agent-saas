// voiceagent-saas/compliance.js

/**
 * Merged compliance module: DNC enforcement, schedule validation, and
 * compliance gate orchestrator.
 *
 * Exports: ComplianceGate, DncEnforcer, isWithinScheduleWindows, isScheduleDay
 *
 * Sources:
 *   - apps/voice-engine/src/compliance.ts
 *   - apps/voice-engine/src/schedule.ts
 *   - apps/voice-engine/src/dnc.ts
 */

// ─── Schedule ───────────────────────────────────────────────────────

const ISRAEL_TZ = "Asia/Jerusalem";

const DAY_MAP = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Get the current hour, minute, and day in Israel timezone.
 */
function getIsraelTime(now = new Date()) {
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

  const weekdayStr = (weekdayPart?.value ?? "Sun").toLowerCase().slice(0, 3);
  const dayOfWeek = DAY_MAP[weekdayStr] ?? 0;
  const dayName = DAY_NAMES[dayOfWeek];

  return { hours, minutes, dayOfWeek, dayName };
}

/**
 * Parse "HH:mm" string to total minutes since midnight.
 */
function parseTimeToMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Check if the current time (Israel TZ) falls within any of the schedule windows.
 * Saturday (Shabbat) is always blocked.
 *
 * @param {Array<{start: string, end: string}>} windows - Schedule windows in "HH:mm" format
 * @param {string[]} scheduleDays - Allowed day names (e.g. ["sun", "mon", "tue"])
 * @param {Date} [now] - Optional override for current time
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function isWithinScheduleWindows(windows, scheduleDays, now = new Date()) {
  const israel = getIsraelTime(now);

  // Rule 1: Shabbat is always blocked
  if (israel.dayOfWeek === 6) {
    return {
      allowed: false,
      reason: "Shabbat \u2014 no calls allowed on Saturday",
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
 * Check if a given day name is a scheduled day (and not Shabbat).
 *
 * @param {string} dayName - Day name (e.g. "sun", "mon")
 * @param {string[]} scheduleDays - Allowed day names
 * @returns {boolean}
 */
export function isScheduleDay(dayName, scheduleDays) {
  if (DAY_MAP[dayName] === 6) return false; // Shabbat always blocked
  return scheduleDays.includes(dayName);
}

/**
 * Find the next valid schedule window start time as a UTC Date.
 * Looks up to 7 days ahead. Returns null if no valid window found.
 */
export function getNextScheduleWindow(windows, scheduleDays, now = new Date()) {
  const israel = getIsraelTime(now);
  const currentMinutes = israel.hours * 60 + israel.minutes;

  const sorted = [...windows].sort(
    (a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start)
  );

  // Check remaining windows today
  if (scheduleDays.includes(israel.dayName) && israel.dayOfWeek !== 6) {
    for (const window of sorted) {
      const startMinutes = parseTimeToMinutes(window.start);
      if (startMinutes > currentMinutes) {
        const diffMinutes = startMinutes - currentMinutes;
        return new Date(now.getTime() + diffMinutes * 60 * 1000);
      }
    }
  }

  // Check subsequent days (up to 7)
  for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
    const futureDate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const futureIsrael = getIsraelTime(futureDate);

    if (futureIsrael.dayOfWeek === 6) continue;
    if (!scheduleDays.includes(futureIsrael.dayName)) continue;

    if (sorted.length > 0) {
      const firstWindowStart = parseTimeToMinutes(sorted[0].start);
      const futureMinutes = futureIsrael.hours * 60 + futureIsrael.minutes;
      const diffMinutes = firstWindowStart - futureMinutes;
      return new Date(futureDate.getTime() + diffMinutes * 60 * 1000);
    }
  }

  return null;
}

// ─── DNC Enforcer ───────────────────────────────────────────────────

export class DncEnforcer {
  /**
   * @param {object} contactDAL
   * @param {object} auditDAL
   * @param {object} campaignContactDAL
   */
  constructor(contactDAL, auditDAL, campaignContactDAL) {
    this.contactDAL = contactDAL;
    this.auditDAL = auditDAL;
    this.campaignContactDAL = campaignContactDAL;
  }

  /**
   * Check if a contact is on the DNC list before initiating a call.
   * Always logs the check to audit_log regardless of result.
   */
  async checkDnc(contactId) {
    const isDnc = await this.contactDAL.isDnc(contactId);

    await this.auditDAL.log("dnc_check", "contact", contactId, {
      is_dnc: isDnc,
      blocked: isDnc,
      checked_at: new Date().toISOString(),
    });

    if (isDnc) {
      return {
        blocked: true,
        reason: `Contact ${contactId} is on the DNC list`,
      };
    }

    return { blocked: false };
  }

  /**
   * Mark a contact as DNC due to opt-out during a call.
   */
  async markOptOut(contactId, campaignContactId) {
    await this.contactDAL.markDnc(contactId, "opt_out");

    if (campaignContactId) {
      await this.campaignContactDAL.updateStatus(campaignContactId, "dnc");
    }

    await this.auditDAL.log("opt_out", "contact", contactId, {
      source: "opt_out",
      campaign_contact_id: campaignContactId ?? null,
      marked_at: new Date().toISOString(),
    });
  }

  /**
   * Mark a contact as DNC manually (dashboard action or bulk upload).
   */
  async markDncManual(contactId) {
    await this.contactDAL.markDnc(contactId, "manual");

    await this.auditDAL.log("dnc_set", "contact", contactId, {
      source: "manual",
      marked_at: new Date().toISOString(),
    });
  }

  /**
   * Check the national DNC registry.
   * STUB: placeholder for future integration with Israel's national registry.
   */
  async checkNationalRegistry(phone) {
    await this.auditDAL.log("dnc_check", "contact", null, {
      registry: "national",
      phone_suffix: phone.slice(-4),
      stub: true,
      result: "not_checked",
      checked_at: new Date().toISOString(),
    });

    return {
      blocked: false,
      stub: true,
      reason: "National registry check not yet integrated (stub)",
    };
  }

  /**
   * Bulk mark contacts as DNC from a tenant's uploaded exclusion list.
   */
  async bulkMarkDnc(contactIds) {
    let marked = 0;
    const errors = [];

    for (const contactId of contactIds) {
      try {
        await this.contactDAL.markDnc(contactId, "manual");
        await this.auditDAL.log("dnc_set", "contact", contactId, {
          source: "manual",
          bulk: true,
          marked_at: new Date().toISOString(),
        });
        marked++;
      } catch (err) {
        errors.push({
          contactId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { marked, errors };
  }
}

// ─── Compliance Gate ────────────────────────────────────────────────

/** Hebrew recording consent disclosure (Israeli law requirement). */
const RECORDING_CONSENT_TEXT =
  "\u05E9\u05D9\u05DD \u05DC\u05D1, \u05D4\u05E9\u05D9\u05D7\u05D4 \u05DE\u05D5\u05E7\u05DC\u05D8\u05EA \u05DC\u05E6\u05D5\u05E8\u05DA \u05E9\u05D9\u05E4\u05D5\u05E8 \u05D4\u05E9\u05D9\u05E8\u05D5\u05EA.";

/** Opt-out offer text injected into every call script. */
const OPT_OUT_OFFER_TEXT =
  "\u05D0\u05DD \u05D0\u05D9\u05E0\u05DA \u05DE\u05E2\u05D5\u05E0\u05D9\u05D9\u05DF \u05E9\u05E0\u05EA\u05E7\u05E9\u05E8 \u05D0\u05DC\u05D9\u05DA \u05D1\u05E2\u05EA\u05D9\u05D3, \u05D0\u05DE\u05D5\u05E8 \u05DC\u05D9 \u05D5\u05D0\u05E1\u05D9\u05E8 \u05D0\u05D5\u05EA\u05DA \u05DE\u05D4\u05E8\u05E9\u05D9\u05DE\u05D4.";

export class ComplianceGate {
  /**
   * @param {DncEnforcer} dncEnforcer
   * @param {object} auditDAL
   * @param {object} tenantDAL
   * @param {object} contactDAL
   */
  constructor(dncEnforcer, auditDAL, tenantDAL, contactDAL) {
    this.dncEnforcer = dncEnforcer;
    this.auditDAL = auditDAL;
    this.tenantDAL = tenantDAL;
    this.contactDAL = contactDAL;
  }

  /**
   * Run all pre-call compliance checks. Returns a clear allow/deny.
   * Checks run in order: DNC -> Schedule -> Call Limit.
   * First failure short-circuits.
   */
  async preCallCheck(params) {
    const { contactId, campaign } = params;
    const checks = {
      dnc: "pass",
      schedule: "pass",
      callLimit: "pass",
    };

    // 1. DNC check
    try {
      const dncResult = await this.dncEnforcer.checkDnc(contactId);
      if (dncResult.blocked) {
        checks.dnc = "blocked";
        return {
          allowed: false,
          reason: dncResult.reason ?? "Contact is on the DNC list",
          checks,
        };
      }
    } catch (err) {
      checks.dnc = "error";
      return {
        allowed: false,
        reason: `DNC check failed: ${err instanceof Error ? err.message : String(err)}`,
        checks,
      };
    }

    // 2. Schedule check
    const scheduleResult = isWithinScheduleWindows(
      campaign.schedule_windows,
      campaign.schedule_days
    );

    await this.auditDAL.log("schedule_check", "campaign", campaign.id, {
      allowed: scheduleResult.allowed,
      reason: scheduleResult.reason ?? null,
      windows: campaign.schedule_windows,
      days: campaign.schedule_days,
      checked_at: new Date().toISOString(),
    });

    if (!scheduleResult.allowed) {
      checks.schedule = "blocked";
      return {
        allowed: false,
        reason: scheduleResult.reason ?? "Outside schedule window",
        checks,
      };
    }

    // 3. Call limit check
    const underLimit = await this.tenantDAL.isUnderCallLimit();
    if (!underLimit) {
      checks.callLimit = "blocked";

      await this.auditDAL.log("call_limit_reached", "contact", contactId, {
        campaign_id: campaign.id,
        checked_at: new Date().toISOString(),
      });

      return {
        allowed: false,
        reason: "Tenant has reached the monthly call limit",
        checks,
      };
    }

    return { allowed: true, checks };
  }

  /**
   * Get the recording consent disclosure text.
   */
  static getRecordingConsentText() {
    return RECORDING_CONSENT_TEXT;
  }

  /**
   * Get the opt-out offer text.
   */
  static getOptOutOfferText() {
    return OPT_OUT_OFFER_TEXT;
  }

  /**
   * Inject recording consent disclosure and opt-out offer into a campaign script.
   */
  injectRecordingConsent(script) {
    const consentBlock = [
      "--- COMPLIANCE (mandatory, do not skip) ---",
      `At the very start of the call, say exactly: "${RECORDING_CONSENT_TEXT}"`,
      `If the contact asks to be removed, say: "${OPT_OUT_OFFER_TEXT}" and call the mark_opt_out tool.`,
      "--- END COMPLIANCE ---",
      "",
      script,
    ].join("\n");

    return consentBlock;
  }

  /**
   * Log call_start event to audit.
   */
  async logCallStart(params) {
    await this.auditDAL.log("call_start", "call", params.callId, {
      contact_id: params.contactId,
      campaign_id: params.campaignId,
      started_at: new Date().toISOString(),
    });
  }

  /**
   * Log call_end event to audit.
   */
  async logCallEnd(params) {
    await this.auditDAL.log("call_end", "call", params.callId, {
      contact_id: params.contactId,
      campaign_id: params.campaignId,
      disposition: params.disposition,
      duration_seconds: params.durationSeconds ?? null,
      lead_status: params.leadStatus ?? null,
      ended_at: new Date().toISOString(),
    });
  }

  /**
   * Log that recording consent was announced at call start.
   */
  async logRecordingConsent(callId) {
    await this.auditDAL.log("recording_consent", "call", callId, {
      disclosure_text: RECORDING_CONSENT_TEXT,
      announced_at: new Date().toISOString(),
    });
  }
}
