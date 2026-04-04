import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { CampaignCard } from "@/components/campaign-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default async function CampaignsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  // Fetch all campaigns
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  // Fetch contact counts for each campaign
  const campaignIds = (campaigns ?? []).map((c) => c.id);
  const { data: campaignContacts } = campaignIds.length > 0
    ? await supabase
        .from("campaign_contacts")
        .select("campaign_id, status")
        .eq("tenant_id", tenantId)
        .in("campaign_id", campaignIds)
    : { data: [] };

  // Aggregate counts per campaign
  const countsMap = new Map<string, { total: number; completed: number; pending: number; failed: number }>();
  for (const cc of campaignContacts ?? []) {
    if (!countsMap.has(cc.campaign_id)) {
      countsMap.set(cc.campaign_id, { total: 0, completed: 0, pending: 0, failed: 0 });
    }
    const entry = countsMap.get(cc.campaign_id)!;
    entry.total++;
    if (cc.status === "completed") entry.completed++;
    if (cc.status === "pending" || cc.status === "queued") entry.pending++;
    if (cc.status === "failed" || cc.status === "dead_letter") entry.failed++;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">קמפיינים</h1>
        <Link href="/campaigns/new">
          <Button>
            <svg className="w-4 h-4 ms-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            קמפיין חדש
          </Button>
        </Link>
      </div>

      {(!campaigns || campaigns.length === 0) ? (
        <EmptyState
          icon={
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
            </svg>
          }
          title="אין קמפיינים עדיין"
          description="צור את הקמפיין הראשון שלך ותתחיל להתקשר ללידים"
          action={
            <Link href="/campaigns/new">
              <Button>צור קמפיין חדש</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {campaigns.map((campaign) => (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              contactCounts={
                countsMap.get(campaign.id) ?? { total: 0, completed: 0, pending: 0, failed: 0 }
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
