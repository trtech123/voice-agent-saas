import { createClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { CampaignDetailClient } from "./campaign-detail-client";

interface Props {
  params: { id: string };
}

export default async function CampaignDetailPage({ params }: Props) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenantId = user.app_metadata?.tenant_id;
  if (!tenantId) redirect("/login");

  const campaignId = params.id;

  // Fetch campaign
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("tenant_id", tenantId)
    .single();

  if (!campaign) redirect("/campaigns");

  // Fetch campaign contacts with their contact details and latest call
  const { data: campaignContacts } = await supabase
    .from("campaign_contacts")
    .select("*, contacts(*), calls(*)")
    .eq("campaign_id", campaignId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });

  // Build contacts data
  const contactRows = (campaignContacts ?? []).map((cc: any) => ({
    campaignContact: { ...cc, contacts: undefined, calls: undefined },
    contact: cc.contacts,
    call: cc.calls?.[0] ?? null,
  }));

  // Compute stats
  const stats = {
    total: contactRows.length,
    called: contactRows.filter((r: any) => r.campaignContact.status !== "pending").length,
    answered: contactRows.filter((r: any) => r.call?.status === "completed" || r.call?.status === "connected").length,
    qualified: contactRows.filter((r: any) => r.call?.lead_status && r.call.lead_status !== "not_interested").length,
    hot: contactRows.filter((r: any) => r.call?.lead_status === "hot").length,
    warm: contactRows.filter((r: any) => r.call?.lead_status === "warm").length,
    cold: contactRows.filter((r: any) => r.call?.lead_status === "cold").length,
    notInterested: contactRows.filter((r: any) => r.call?.lead_status === "not_interested").length,
    noAnswer: contactRows.filter((r: any) => r.campaignContact.status === "no_answer").length,
    failed: contactRows.filter((r: any) => r.campaignContact.status === "failed" || r.call?.status === "dead_letter").length,
  };

  // Fetch failed / dead-letter calls
  const { data: failedCallsRaw } = await supabase
    .from("calls")
    .select("*, contacts!inner(*)")
    .eq("campaign_id", campaignId)
    .eq("tenant_id", tenantId)
    .in("status", ["dead_letter", "failed"])
    .order("created_at", { ascending: false });

  const failedCalls = (failedCallsRaw ?? []).map((row: any) => ({
    call: { ...row, contacts: undefined },
    contact: row.contacts,
  }));

  // Fetch transcripts
  const { data: callIds } = await supabase
    .from("calls")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("tenant_id", tenantId);

  const callIdList = (callIds ?? []).map((c) => c.id);

  let transcriptRows: any[] = [];
  if (callIdList.length > 0) {
    const { data: transcriptsRaw } = await supabase
      .from("call_transcripts")
      .select("*, calls!inner(*, contacts!inner(*))")
      .eq("tenant_id", tenantId)
      .in("call_id", callIdList);

    transcriptRows = (transcriptsRaw ?? []).map((row: any) => ({
      transcript: { ...row, calls: undefined },
      call: { ...row.calls, contacts: undefined },
      contact: row.calls.contacts,
    }));
  }

  return (
    <CampaignDetailClient
      campaign={campaign}
      stats={stats}
      contacts={contactRows}
      failedCalls={failedCalls}
      transcripts={transcriptRows}
    />
  );
}
