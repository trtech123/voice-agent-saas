import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { CampaignCard } from "@/components/campaign-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Plus, Megaphone } from "lucide-react";

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
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-[#1E1B4B]">קמפיינים</h1>
        <Link href="/campaigns/new">
          <Button size="md">
            <Plus className="w-4 h-4" />
            קמפיין חדש
          </Button>
        </Link>
      </div>

      {(!campaigns || campaigns.length === 0) ? (
        <div className="bg-white/80 backdrop-blur-sm border border-white/20 rounded-xl shadow-md">
          <EmptyState
            icon={<Megaphone className="w-10 h-10" />}
            title="אין קמפיינים עדיין"
            description="צור את הקמפיין הראשון שלך ותתחיל להתקשר ללידים"
            action={
              <Link href="/campaigns/new">
                <Button>
                  <Plus className="w-4 h-4" />
                  צור קמפיין חדש
                </Button>
              </Link>
            }
          />
        </div>
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
