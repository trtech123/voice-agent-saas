import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { WhatsAppForm } from "@/components/settings/whatsapp-form";
import { SettingsLayout } from "@/components/settings/settings-layout";

export default async function WhatsAppPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  const { data: tenant } = await supabase
    .from("tenants")
    .select("whatsapp_credentials")
    .eq("id", tenantId)
    .single();

  return (
    <SettingsLayout title="WhatsApp Business">
      <WhatsAppForm hasCredentials={!!tenant?.whatsapp_credentials} />
    </SettingsLayout>
  );
}
