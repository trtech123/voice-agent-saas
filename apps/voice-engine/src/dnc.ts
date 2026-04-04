// apps/voice-engine/src/dnc.ts

/**
 * DNC (Do Not Call) enforcement module.
 *
 * Wraps ContactDAL DNC operations with audit logging.
 * Provides:
 *   - Pre-call DNC check (logged)
 *   - Mid-call opt-out marking (via Gemini mark_opt_out tool)
 *   - Manual DNC marking (dashboard / bulk upload)
 *   - National registry stub (interface ready for future integration)
 */

import type { ContactDAL } from "@vam/database";
import type { AuditLogDAL } from "@vam/database";
import type { CampaignContactDAL } from "@vam/database";

export interface DncCheckResult {
  blocked: boolean;
  reason?: string;
}

export interface NationalRegistryResult {
  blocked: boolean;
  stub: boolean;
  reason?: string;
}

export class DncEnforcer {
  constructor(
    private contactDAL: ContactDAL,
    private auditDAL: AuditLogDAL,
    private campaignContactDAL: CampaignContactDAL
  ) {}

  /**
   * Check if a contact is on the DNC list before initiating a call.
   * Always logs the check to audit_log regardless of result.
   */
  async checkDnc(contactId: string): Promise<DncCheckResult> {
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
   * Called when Gemini invokes the mark_opt_out tool.
   * Also updates the campaign_contact status to 'dnc'.
   */
  async markOptOut(
    contactId: string,
    campaignContactId?: string
  ): Promise<void> {
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
  async markDncManual(contactId: string): Promise<void> {
    await this.contactDAL.markDnc(contactId, "manual");

    await this.auditDAL.log("dnc_set", "contact", contactId, {
      source: "manual",
      marked_at: new Date().toISOString(),
    });
  }

  /**
   * Check the national DNC registry.
   *
   * STUB: This is an interface placeholder for future integration with
   * Israel's national Do Not Call registry. Currently returns blocked=false
   * for all numbers. When integrated, this will make an HTTP call to the
   * registry API and cache results.
   */
  async checkNationalRegistry(
    phone: string
  ): Promise<NationalRegistryResult> {
    // TODO: Integrate with national DNC registry API when available.
    // Expected interface:
    //   POST https://api.dnc.gov.il/check
    //   Body: { phone: "972..." }
    //   Response: { registered: boolean, registered_at: string }

    await this.auditDAL.log("dnc_check", "contact", null, {
      registry: "national",
      phone_suffix: phone.slice(-4), // Log only last 4 digits for privacy
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
   * Each contact is marked individually with an audit log entry.
   */
  async bulkMarkDnc(contactIds: string[]): Promise<{
    marked: number;
    errors: Array<{ contactId: string; error: string }>;
  }> {
    let marked = 0;
    const errors: Array<{ contactId: string; error: string }> = [];

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
