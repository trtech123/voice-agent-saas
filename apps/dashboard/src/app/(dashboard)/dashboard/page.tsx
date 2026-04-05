import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { formatNumber } from "@/lib/utils/format";
import { DashboardClient } from "./dashboard-client";
import { QuickCallCard } from "@/components/quick-call-card";
import {
  Phone,
  Megaphone,
  Flame,
  Crown,
} from "lucide-react";

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

  const planLabels: Record<string, string> = {
    basic: "בסיסי",
    pro: "מקצועי",
    enterprise: "ארגוני",
  };

  const callsUsed = tenant?.calls_used_this_month ?? 0;
  const callsLimit = tenant?.calls_limit ?? 0;
  const callsRemaining = callsLimit - callsUsed;

  return (
    <div>
      {/* Welcome header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[#1E1B4B]">
          שלום, {tenant?.name ?? "עסק"}
        </h1>
        <p className="text-[#1E1B4B]/50 text-sm mt-1">
          הנה סיכום הפעילות שלך
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {/* Calls this month */}
        <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-5 transition-all duration-200 hover:shadow-lg">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-[#1E1B4B]/50">שיחות החודש</p>
              <p className="text-3xl font-bold text-[#1E1B4B] mt-2">
                {formatNumber(callsUsed)}
              </p>
              <p className="text-xs text-[#1E1B4B]/40 mt-1">
                מתוך {formatNumber(callsLimit)} | נותרו {formatNumber(callsRemaining)}
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-indigo-100/80 flex items-center justify-center">
              <Phone className="w-5 h-5 text-indigo-500" />
            </div>
          </div>
        </div>

        {/* Active campaigns */}
        <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-5 transition-all duration-200 hover:shadow-lg">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-[#1E1B4B]/50">קמפיינים פעילים</p>
              <p className="text-3xl font-bold text-[#1E1B4B] mt-2">{activeCampaigns ?? 0}</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-indigo-100/80 flex items-center justify-center">
              <Megaphone className="w-5 h-5 text-indigo-500" />
            </div>
          </div>
        </div>

        {/* Hot leads -- green accent */}
        <div className="bg-white/80 backdrop-blur-sm border border-emerald-200/40 rounded-xl shadow-md p-5 transition-all duration-200 hover:shadow-lg">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-[#1E1B4B]/50">לידים חמים</p>
              <p className="text-3xl font-bold text-emerald-600 mt-2">{hotLeads.length}</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-emerald-100/80 flex items-center justify-center">
              <Flame className="w-5 h-5 text-emerald-500" />
            </div>
          </div>
        </div>

        {/* Plan tier */}
        <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md p-5 transition-all duration-200 hover:shadow-lg">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-[#1E1B4B]/50">תוכנית</p>
              <p className="text-3xl font-bold text-[#1E1B4B] mt-2">
                {planLabels[tenant?.plan] ?? tenant?.plan ?? "בסיסי"}
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-indigo-100/80 flex items-center justify-center">
              <Crown className="w-5 h-5 text-indigo-500" />
            </div>
          </div>
        </div>
      </div>

      {/* Quick Call card */}
      <div className="mb-6">
        <QuickCallCard />
      </div>

      {/* Main content: live feed + hot leads + chart */}
      <DashboardClient
        tenantId={tenantId}
        hotLeads={hotLeads}
        chartData={chartData}
      />
    </div>
  );
}
