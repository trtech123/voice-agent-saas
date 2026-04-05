// packages/database/src/dal/campaign-contacts.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, CampaignContact } from "../types.js";

export class CampaignContactDAL {
  constructor(
    private db: SupabaseClient<Database>,
    private tenantId: string
  ) {}

  async getById(id: string): Promise<CampaignContact | null> {
    const { data, error } = await this.db
      .from("campaign_contacts")
      .select("*")
      .eq("id", id)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  async getByCampaignAndContact(
    campaignId: string,
    contactId: string
  ): Promise<CampaignContact | null> {
    const { data, error } = await this.db
      .from("campaign_contacts")
      .select("*")
      .eq("campaign_id", campaignId)
      .eq("contact_id", contactId)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  async listPending(campaignId: string, limit: number): Promise<CampaignContact[]> {
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from("campaign_contacts")
      .select("*")
      .eq("campaign_id", campaignId)
      .eq("tenant_id", this.tenantId)
      .in("status", ["pending", "no_answer"])
      .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  }

  async enrollContacts(campaignId: string, contactIds: string[]): Promise<CampaignContact[]> {
    const rows = contactIds.map((contactId) => ({
      campaign_id: campaignId,
      contact_id: contactId,
      tenant_id: this.tenantId,
    }));
    const { data, error } = await this.db
      .from("campaign_contacts")
      .upsert(rows, { onConflict: "tenant_id,contact_id,campaign_id" })
      .select();
    if (error) throw error;
    return data ?? [];
  }

  async updateStatus(
    id: string,
    status: CampaignContact["status"],
    extra?: { call_id?: string; next_retry_at?: string; attempt_count?: number }
  ): Promise<void> {
    const { error } = await this.db
      .from("campaign_contacts")
      .update({ status, ...extra })
      .eq("id", id)
      .eq("tenant_id", this.tenantId);
    if (error) throw error;
  }

  async countByStatus(campaignId: string): Promise<Record<string, number>> {
    const { data, error } = await this.db
      .from("campaign_contacts")
      .select("status")
      .eq("campaign_id", campaignId)
      .eq("tenant_id", this.tenantId);
    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return counts;
  }
}
