import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { ProfileForm } from "@/components/settings/profile-form";
import { SettingsLayout } from "@/components/settings/settings-layout";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  const { data: tenant } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .single();

  if (!tenant) redirect("/dashboard");

  return (
    <SettingsLayout title="פרופיל עסקי">
      <ProfileForm tenant={tenant} />
    </SettingsLayout>
  );
}
