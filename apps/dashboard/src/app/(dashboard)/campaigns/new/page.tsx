import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { WizardShell } from "@/components/campaign-wizard/wizard-shell";

export default async function NewCampaignPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  // Fetch templates (system + tenant)
  const { data: templates } = await supabase
    .from("templates")
    .select("*")
    .or(`is_system.eq.true,tenant_id.eq.${tenantId}`)
    .order("is_system", { ascending: false });

  return (
    <div>
      <h1 className="text-2xl font-bold text-[#1E1B4B] mb-8">קמפיין חדש</h1>
      <WizardShell templates={templates ?? []} tenantId={tenantId} />
    </div>
  );
}
