// packages/database/src/dal/tenants.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tenant } from "../types.js";

export class TenantDAL {
  constructor(
    private db: SupabaseClient<Database>,
    private tenantId: string
  ) {}

  async get(): Promise<Tenant | null> {
    const { data, error } = await this.db
      .from("tenants")
      .select("*")
      .eq("id", this.tenantId)
      .single();
    if (error) throw error;
    return data;
  }

  async incrementCallsUsed(): Promise<number> {
    const { data, error } = await this.db.rpc("increment_calls_used", {
      p_tenant_id: this.tenantId,
    });
    if (error) throw error;
    return data as number;
  }

  async isUnderCallLimit(): Promise<boolean> {
    const tenant = await this.get();
    if (!tenant) throw new Error(`Tenant ${this.tenantId} not found`);
    return tenant.calls_used_this_month < tenant.calls_limit;
  }
}
