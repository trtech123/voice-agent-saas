// packages/database/src/dal/templates.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Template } from "../types.js";

export class TemplateDAL {
  constructor(
    private db: SupabaseClient<Database>,
    private tenantId: string
  ) {}

  async listAll(): Promise<Template[]> {
    const { data, error } = await this.db
      .from("templates")
      .select("*")
      .or(`is_system.eq.true,tenant_id.eq.${this.tenantId}`)
      .order("is_system", { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  async getById(templateId: string): Promise<Template | null> {
    const { data, error } = await this.db
      .from("templates")
      .select("*")
      .eq("id", templateId)
      .or(`is_system.eq.true,tenant_id.eq.${this.tenantId}`)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  async create(template: Omit<Database["public"]["Tables"]["templates"]["Insert"], "tenant_id">): Promise<Template> {
    const { data, error } = await this.db
      .from("templates")
      .insert({ ...template, tenant_id: this.tenantId, is_system: false })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async cloneSystem(templateId: string, overrides?: Partial<Database["public"]["Tables"]["templates"]["Insert"]>): Promise<Template> {
    const source = await this.getById(templateId);
    if (!source || !source.is_system) throw new Error("Template not found or not a system template");
    return this.create({
      name: overrides?.name ?? `${source.name} (copy)`,
      business_type: overrides?.business_type ?? source.business_type,
      script: overrides?.script ?? source.script,
      questions: overrides?.questions ?? source.questions,
      whatsapp_template: overrides?.whatsapp_template ?? source.whatsapp_template,
    });
  }
}
