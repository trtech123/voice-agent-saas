import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { TeamTable } from "@/components/settings/team-table";
import { SettingsLayout } from "@/components/settings/settings-layout";

export default async function TeamPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  const { data: appUser } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  const { data: teamUsers } = await supabase
    .from("users")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });

  return (
    <SettingsLayout title="ניהול צוות">
      <TeamTable
        users={teamUsers ?? []}
        currentUserId={user.id}
        isOwner={appUser?.role === "owner"}
        tenantId={tenantId}
      />
    </SettingsLayout>
  );
}
