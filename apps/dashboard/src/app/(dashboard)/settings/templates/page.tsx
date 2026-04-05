import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { TemplateLibrary } from "@/components/settings/template-library";
import { SettingsLayout } from "@/components/settings/settings-layout";

export default async function TemplatesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  const { data: templates } = await supabase
    .from("templates")
    .select("*")
    .or(`is_system.eq.true,tenant_id.eq.${tenantId}`)
    .order("is_system", { ascending: false });

  return (
    <SettingsLayout title="ספריית תבניות">
      <TemplateLibrary templates={templates ?? []} tenantId={tenantId} />
    </SettingsLayout>
  );
}
