import { QuickCallCard } from "@/components/quick-call-card";
import {
  buildCallSummary,
  getCallTimestamp,
  getDashboardContact,
  getHigherPriorityStatus,
  getLeadKey,
  getLeadStatus,
  getOutcomeFromCall,
  type DashboardHotLead,
} from "@/lib/dashboard";
import { createClient } from "@/lib/supabase-server";
import { formatNumber } from "@/lib/utils/format";
import { Crown, Flame, Megaphone, Phone } from "lucide-react";
import { redirect } from "next/navigation";
import { DashboardClient } from "./dashboard-client";
import type { Call, Contact } from "@vam/database";

type HotLeadQueryRow = Call & {
  contacts: Pick<Contact, "id" | "name" | "phone"> | Array<Pick<Contact, "id" | "name" | "phone">> | null;
};

type LeadAggregate = {
  contact: NonNullable<ReturnType<typeof getDashboardContact>>;
  representativeCall: Call;
};

function normalizeContact(
  contact: HotLeadQueryRow["contacts"]
): Pick<Contact, "id" | "name" | "phone"> | null {
  if (Array.isArray(contact)) return contact[0] ?? null;
  return contact;
}

function getRepresentativeCall(current: Call, next: Call) {
  const currentScore = current.lead_score ?? 0;
  const nextScore = next.lead_score ?? 0;

  if (nextScore !== currentScore) {
    return nextScore > currentScore ? next : current;
  }

  return new Date(getCallTimestamp(next)).getTime() > new Date(getCallTimestamp(current)).getTime()
    ? next
    : current;
}

function buildHotLeadItems(
  candidates: HotLeadQueryRow[],
  callsByLead: Map<string, Call[]>
): DashboardHotLead[] {
  const uniqueLeads = new Map<string, LeadAggregate>();

  for (const row of candidates) {
    const contact = getDashboardContact(normalizeContact(row.contacts));
    if (!contact) continue;

    const call: Call = { ...row, contacts: undefined } as Call;
    const key = getLeadKey(contact, call);
    const existing = uniqueLeads.get(key);

    if (!existing) {
      uniqueLeads.set(key, { contact, representativeCall: call });
      continue;
    }

    uniqueLeads.set(key, {
      contact,
      representativeCall: getRepresentativeCall(existing.representativeCall, call),
    });
  }

  return Array.from(uniqueLeads.values())
    .map(({ contact, representativeCall }) => {
      const relatedCalls = callsByLead.get(contact.id) ?? [representativeCall];
      const latestCall = relatedCalls.reduce((latest, current) => {
        return new Date(getCallTimestamp(current)).getTime() > new Date(getCallTimestamp(latest)).getTime()
          ? current
          : latest;
      }, relatedCalls[0]);

      const hottestStatus = relatedCalls.reduce<ReturnType<typeof getLeadStatus>>((status, current) => {
        return getHigherPriorityStatus(status, getLeadStatus(current));
      }, getLeadStatus(representativeCall));

      const highestScore = relatedCalls.reduce((score, current) => {
        return Math.max(score, current.lead_score ?? 0);
      }, representativeCall.lead_score ?? 0);

      const outcome = getOutcomeFromCall(latestCall);

      return {
        leadId: contact.id,
        campaignId: latestCall.campaign_id,
        contact,
        leadScore: highestScore,
        leadStatus: hottestStatus,
        attemptCount: relatedCalls.length,
        latestCallAt: getCallTimestamp(latestCall),
        summary: buildCallSummary(latestCall),
        outcomeLabel: outcome.label,
        outcomeStatus: outcome.status,
      };
    })
    .sort((left, right) => {
      if (right.leadScore !== left.leadScore) {
        return right.leadScore - left.leadScore;
      }

      return new Date(right.latestCallAt).getTime() - new Date(left.latestCallAt).getTime();
    })
    .slice(0, 5);
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  const { data: tenant } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .single();

  const { count: activeCampaigns } = await supabase
    .from("campaigns")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "active");

  const { data: hotCallsRaw } = await supabase
    .from("calls")
    .select("*, contacts!inner(id, name, phone)")
    .eq("tenant_id", tenantId)
    .in("lead_status", ["hot", "warm", "callback"])
    .order("lead_score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  const hotLeadContacts = Array.from(
    new Set(
      (hotCallsRaw ?? [])
        .map((row) => normalizeContact((row as HotLeadQueryRow).contacts)?.id)
        .filter((value): value is string => Boolean(value))
    )
  ).slice(0, 20);

  const { data: hotLeadCalls } = hotLeadContacts.length
    ? await supabase
        .from("calls")
        .select("*")
        .eq("tenant_id", tenantId)
        .in("contact_id", hotLeadContacts)
        .order("created_at", { ascending: false })
    : { data: [] as Call[] };

  const callsByLead = new Map<string, Call[]>();
  for (const call of hotLeadCalls ?? []) {
    const group = callsByLead.get(call.contact_id) ?? [];
    group.push(call);
    callsByLead.set(call.contact_id, group);
  }

  const hotLeads = buildHotLeadItems((hotCallsRaw ?? []) as HotLeadQueryRow[], callsByLead);

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data: recentCalls } = await supabase
    .from("calls")
    .select("status, lead_status, created_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", sevenDaysAgo.toISOString());

  const dayMap = new Map<string, { answered: number; qualified: number; hot: number }>();
  for (const call of recentCalls ?? []) {
    const day = new Date(call.created_at).toLocaleDateString("he-IL", {
      weekday: "short",
      day: "numeric",
    });

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
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[#1E1B4B]">שלום, {tenant?.name ?? "עסק"}</h1>
        <p className="mt-1 text-sm text-[#1E1B4B]/50">הנה סיכום הפעילות שלך</p>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-white/20 bg-white/80 p-5 shadow-md transition-all duration-200 hover:shadow-lg">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-[#1E1B4B]/50">שיחות החודש</p>
              <p className="mt-2 text-3xl font-bold text-[#1E1B4B]">{formatNumber(callsUsed)}</p>
              <p className="mt-1 text-xs text-[#1E1B4B]/40">
                מתוך {formatNumber(callsLimit)} | נותרו {formatNumber(callsRemaining)}
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100/80">
              <Phone className="h-5 w-5 text-indigo-500" />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/20 bg-white/80 p-5 shadow-md transition-all duration-200 hover:shadow-lg">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-[#1E1B4B]/50">קמפיינים פעילים</p>
              <p className="mt-2 text-3xl font-bold text-[#1E1B4B]">{activeCampaigns ?? 0}</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100/80">
              <Megaphone className="h-5 w-5 text-indigo-500" />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-emerald-200/40 bg-white/80 p-5 shadow-md transition-all duration-200 hover:shadow-lg">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-[#1E1B4B]/50">לידים חמים</p>
              <p className="mt-2 text-3xl font-bold text-emerald-600">{hotLeads.length}</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100/80">
              <Flame className="h-5 w-5 text-emerald-500" />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/20 bg-white/80 p-5 shadow-md transition-all duration-200 hover:shadow-lg">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-[#1E1B4B]/50">תוכנית</p>
              <p className="mt-2 text-3xl font-bold text-[#1E1B4B]">
                {planLabels[tenant?.plan] ?? tenant?.plan ?? "בסיסי"}
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100/80">
              <Crown className="h-5 w-5 text-indigo-500" />
            </div>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <QuickCallCard />
      </div>

      <DashboardClient tenantId={tenantId} hotLeads={hotLeads} chartData={chartData} />
    </div>
  );
}
