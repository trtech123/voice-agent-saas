import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { TelephonyForm } from "@/components/settings/telephony-form";
import { SettingsLayout } from "@/components/settings/settings-layout";

export default async function TelephonyPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  const { data: tenant } = await supabase
    .from("tenants")
    .select("voicenter_credentials")
    .eq("id", tenantId)
    .single();

  return (
    <SettingsLayout title="טלפוניה -- Voicenter">
      <TelephonyForm hasCredentials={!!tenant?.voicenter_credentials} />
    </SettingsLayout>
  );
}
