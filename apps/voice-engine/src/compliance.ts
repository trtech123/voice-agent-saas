// apps/voice-engine/src/compliance.ts

/**
 * Compliance orchestrator.
 *
 * Single entry point for all pre-call and in-call compliance checks:
 * 1. DNC enforcement (via DncEnforcer)
 * 2. Schedule window validation (via schedule module)
 * 3. Call limit check (via TenantDAL)
 * 4. Recording consent injection and logging
 * 5. Call start/end audit logging
 *
 * The voice engine worker calls gate.preCallCheck() before every call attempt.
 * If the result is { allowed: false }, the call is skipped and the reason is logged.
 */

import type { AuditLogDAL, TenantDAL, ContactDAL, Campaign } from "@vam/database";
import type { DncEnforcer } from "./dnc.js";
import { isWithinSchedule, type ScheduleWindow } from "./schedule.js";

/** Hebrew recording consent disclosure (Israeli law requirement). */
const RECORDING_CONSENT_TEXT =
  "שים לב, השיחה מוקלטת לצורך שיפור השירות.";

/** Opt-out offer text injected into every call script. */
const OPT_OUT_OFFER_TEXT =
  "אם אינך מעוניין שנתקשר אליך בעתיד, אמור לי ואסיר אותך מהרשימה.";

export interface PreCallCheckParams {
  contactId: string;
  campaignContactId: string;
  campaign: Campaign;
}

export interface PreCallCheckResult {
  allowed: boolean;
  reason?: string;
  checks: {
    dnc: "pass" | "blocked" | "error";
    schedule: "pass" | "blocked";
    callLimit: "pass" | "blocked";
  };
}

export interface CallStartParams {
  callId: string;
  contactId: string;
  campaignId: string;
}

export interface CallEndParams {
  callId: string;
  contactId: string;
  campaignId: string;
  disposition: string;
  durationSeconds?: number;
  leadStatus?: string;
}

export class ComplianceGate {
  constructor(
    private dncEnforcer: DncEnforcer,
    private auditDAL: AuditLogDAL,
    private tenantDAL: TenantDAL,
    private contactDAL: ContactDAL
  ) {}

  /**
   * Run all pre-call compliance checks. Returns a clear allow/deny.
   * Checks run in order: DNC -> Schedule -> Call Limit.
   * First failure short-circuits (no point checking schedule if DNC blocked).
   */
  async preCallCheck(params: PreCallCheckParams): Promise<PreCallCheckResult> {
    const { contactId, campaign } = params;
    const checks: PreCallCheckResult["checks"] = {
      dnc: "pass",
      schedule: "pass",
      callLimit: "pass",
    };

    // 1. DNC check (DncEnforcer handles its own audit logging)
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
      // On DNC check error, fail closed (block the call for safety)
      return {
        allowed: false,
        reason: `DNC check failed: ${err instanceof Error ? err.message : String(err)}`,
        checks,
      };
    }

    // 2. Schedule check
    const scheduleResult = isWithinSchedule(
      campaign.schedule_windows as unknown as ScheduleWindow[],
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
  static getRecordingConsentText(): string {
    return RECORDING_CONSENT_TEXT;
  }

  /**
   * Get the opt-out offer text.
   */
  static getOptOutOfferText(): string {
    return OPT_OUT_OFFER_TEXT;
  }

  /**
   * Inject recording consent disclosure and opt-out offer into a campaign script.
   * These are prepended as system-level instructions for Gemini.
   */
  injectRecordingConsent(script: string): string {
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
  async logCallStart(params: CallStartParams): Promise<void> {
    await this.auditDAL.log("call_start", "call", params.callId, {
      contact_id: params.contactId,
      campaign_id: params.campaignId,
      started_at: new Date().toISOString(),
    });
  }

  /**
   * Log call_end event to audit.
   */
  async logCallEnd(params: CallEndParams): Promise<void> {
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
   * Called after Gemini speaks the consent disclosure.
   */
  async logRecordingConsent(callId: string): Promise<void> {
    await this.auditDAL.log("recording_consent", "call", callId, {
      disclosure_text: RECORDING_CONSENT_TEXT,
      announced_at: new Date().toISOString(),
    });
  }
}
