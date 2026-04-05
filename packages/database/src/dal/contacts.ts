// packages/database/src/dal/contacts.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Contact } from "../types.js";

export class ContactDAL {
  constructor(
    private db: SupabaseClient<Database>,
    private tenantId: string
  ) {}

  async getById(contactId: string): Promise<Contact | null> {
    const { data, error } = await this.db
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  async getByPhone(phone: string): Promise<Contact | null> {
    const { data, error } = await this.db
      .from("contacts")
      .select("*")
      .eq("phone", phone)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  async upsertBatch(contacts: Array<Omit<Database["public"]["Tables"]["contacts"]["Insert"], "tenant_id">>): Promise<Contact[]> {
    const rows = contacts.map((c) => ({ ...c, tenant_id: this.tenantId }));
    const { data, error } = await this.db
      .from("contacts")
      .upsert(rows, { onConflict: "tenant_id,phone" })
      .select();
    if (error) throw error;
    return data ?? [];
  }

  async upsertOne(
    contact: Omit<Database["public"]["Tables"]["contacts"]["Insert"], "tenant_id">
  ): Promise<Contact> {
    const { data, error } = await this.db
      .from("contacts")
      .upsert({ ...contact, tenant_id: this.tenantId }, { onConflict: "tenant_id,phone" })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  async markDnc(contactId: string, source: "manual" | "opt_out" | "national_registry"): Promise<void> {
    const { error } = await this.db
      .from("contacts")
      .update({
        is_dnc: true,
        dnc_at: new Date().toISOString(),
        dnc_source: source,
      })
      .eq("id", contactId)
      .eq("tenant_id", this.tenantId);
    if (error) throw error;
  }

  async isDnc(contactId: string): Promise<boolean> {
    const contact = await this.getById(contactId);
    return contact?.is_dnc ?? true; // Default to DNC if not found (safety)
  }
}
