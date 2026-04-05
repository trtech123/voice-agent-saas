import { createClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Not authenticated", details: error?.message });
  }

  const tenantId = user.app_metadata?.tenant_id;

  // Try fetching campaigns with and without tenant filter
  const { data: allCampaigns, error: allErr } = await supabase
    .from("campaigns")
    .select("id, name, tenant_id, status");

  const { data: filteredCampaigns, error: filtErr } = await supabase
    .from("campaigns")
    .select("id, name, tenant_id, status")
    .eq("tenant_id", tenantId || "none");

  return NextResponse.json({
    user_id: user.id,
    email: user.email,
    app_metadata: user.app_metadata,
    user_metadata: user.user_metadata,
    tenant_id_resolved: tenantId,
    all_campaigns: allCampaigns,
    all_campaigns_error: allErr?.message,
    filtered_campaigns: filteredCampaigns,
    filtered_campaigns_error: filtErr?.message,
  });
}
