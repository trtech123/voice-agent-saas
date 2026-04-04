// packages/database/src/dal/calls.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Call } from "../types.js";

export class CallDAL {
  constructor(
    private db: SupabaseClient<Database>,
    private tenantId: string
  ) {}

  async create(call: Omit<Database["public"]["Tables"]["calls"]["Insert"], "tenant_id">): Promise<Call> {
    const { data, error } = await this.db
      .from("calls")
      .insert({ ...call, tenant_id: this.tenantId })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(callId: string, updates: Database["public"]["Tables"]["calls"]["Update"]): Promise<Call> {
    const { data, error } = await this.db
      .from("calls")
      .update(updates)
      .eq("id", callId)
      .eq("tenant_id", this.tenantId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async getById(callId: string): Promise<Call | null> {
    const { data, error } = await this.db
      .from("calls")
      .select("*")
      .eq("id", callId)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  async getByVoicenterCallId(voicenterCallId: string): Promise<Call | null> {
    const { data, error } = await this.db
      .from("calls")
      .select("*")
      .eq("voicenter_call_id", voicenterCallId)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  async listByCampaign(campaignId: string, options?: { limit?: number; offset?: number }): Promise<Call[]> {
    let query = this.db
      .from("calls")
      .select("*")
      .eq("campaign_id", campaignId)
      .eq("tenant_id", this.tenantId)
      .order("created_at", { ascending: false });
    if (options?.limit) query = query.limit(options.limit);
    if (options?.offset) query = query.range(options.offset, options.offset + (options.limit ?? 50) - 1);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  async listHotLeads(limit = 10): Promise<Call[]> {
    const { data, error } = await this.db
      .from("calls")
      .select("*")
      .eq("tenant_id", this.tenantId)
      .in("lead_status", ["hot", "warm"])
      .order("lead_score", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  }

  async markDeadLetter(callId: string, reason: string): Promise<void> {
    const { error } = await this.db
      .from("calls")
      .update({ status: "dead_letter" as const, failure_reason: reason })
      .eq("id", callId)
      .eq("tenant_id", this.tenantId);
    if (error) throw error;
  }
}
