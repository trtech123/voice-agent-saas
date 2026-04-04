import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { formatNumber } from "@/lib/utils/format";
import { DashboardClient } from "./dashboard-client";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  // Fetch tenant data
  const { data: tenant } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .single();

  // Fetch active campaign count
  const { count: activeCampaigns } = await supabase
    .from("campaigns")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "active");

  // Fetch hot leads (top 5)
  const { data: hotCallsRaw } = await supabase
    .from("calls")
    .select("*, contacts!inner(*)")
    .eq("tenant_id", tenantId)
    .in("lead_status", ["hot", "warm"])
    .order("lead_score", { ascending: false })
    .limit(5);

  const hotLeads = (hotCallsRaw ?? []).map((row: any) => ({
    call: { ...row, contacts: undefined },
    contact: row.contacts,
  }));

  // Fetch performance data (last 7 days, grouped by day)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data: recentCalls } = await supabase
    .from("calls")
    .select("status, lead_status, created_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", sevenDaysAgo.toISOString());

  // Group by day for chart
  const dayMap = new Map<string, { answered: number; qualified: number; hot: number }>();
  for (const call of recentCalls ?? []) {
    const day = new Date(call.created_at).toLocaleDateString("he-IL", { weekday: "short", day: "numeric" });
    if (!dayMap.has(day)) dayMap.set(day, { answered: 0, qualified: 0, hot: 0 });
    const entry = dayMap.get(day)!;
    if (call.status === "completed" || call.status === "connected") entry.answered++;
    if (call.lead_status && call.lead_status !== "not_interested") entry.qualified++;
    if (call.lead_status === "hot") entry.hot++;
  }

  const chartData = Array.from(dayMap.entries()).map(([label, data]) => ({
    label,
    ...data,
  }));

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">דשבורד ראשי</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500">שיחות החודש</p>
          <p className="text-2xl font-bold mt-1">
            {formatNumber(tenant?.calls_used_this_month ?? 0)}
            <span className="text-base font-normal text-gray-400">
              /{formatNumber(tenant?.calls_limit ?? 0)}
            </span>
          </p>
          <p className="text-xs text-gray-400 mt-1">
            נותרו {formatNumber((tenant?.calls_limit ?? 0) - (tenant?.calls_used_this_month ?? 0))}
          </p>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500">קמפיינים פעילים</p>
          <p className="text-2xl font-bold mt-1">{activeCampaigns ?? 0}</p>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500">לידים חמים</p>
          <p className="text-2xl font-bold mt-1 text-red-600">{hotLeads.length}</p>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500">תוכנית</p>
          <p className="text-2xl font-bold mt-1 capitalize">{tenant?.plan ?? "basic"}</p>
        </div>
      </div>

      {/* Main content grid */}
      <DashboardClient
        tenantId={tenantId}
        hotLeads={hotLeads}
        chartData={chartData}
      />
    </div>
  );
}
