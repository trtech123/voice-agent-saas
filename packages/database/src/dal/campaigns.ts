// packages/database/src/dal/campaigns.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Campaign } from "../types.js";

export class CampaignDAL {
  constructor(
    private db: SupabaseClient<Database>,
    private tenantId: string
  ) {}

  async getById(campaignId: string): Promise<Campaign | null> {
    const { data, error } = await this.db
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  async list(): Promise<Campaign[]> {
    const { data, error } = await this.db
      .from("campaigns")
      .select("*")
      .eq("tenant_id", this.tenantId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  async create(campaign: Omit<Database["public"]["Tables"]["campaigns"]["Insert"], "tenant_id">): Promise<Campaign> {
    const { data, error } = await this.db
      .from("campaigns")
      .insert({ ...campaign, tenant_id: this.tenantId })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(campaignId: string, updates: Database["public"]["Tables"]["campaigns"]["Update"]): Promise<Campaign> {
    const { data, error } = await this.db
      .from("campaigns")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("tenant_id", this.tenantId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}
