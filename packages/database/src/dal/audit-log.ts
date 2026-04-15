// packages/database/src/dal/audit-log.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, AuditLogEntry } from "../types.js";

export class AuditLogDAL {
  constructor(
    private db: SupabaseClient<Database>,
    private tenantId: string
  ) {}

  async log(
    action: string,
    entityType: string,
    entityId: string | null,
    details?: Record<string, unknown>
  ): Promise<void> {
    const { error } = await this.db
      .from("audit_log")
      .insert({
        tenant_id: this.tenantId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        details: (details ?? null) as Json | null,
      });
    if (error) throw error;
  }

  async list(options?: { action?: string; limit?: number }): Promise<AuditLogEntry[]> {
    let query = this.db
      .from("audit_log")
      .select("*")
      .eq("tenant_id", this.tenantId)
      .order("created_at", { ascending: false });
    if (options?.action) query = query.eq("action", options.action);
    if (options?.limit) query = query.limit(options.limit);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }
}
