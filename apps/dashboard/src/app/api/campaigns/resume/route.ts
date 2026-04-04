import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { getCallQueue } from "@/lib/bullmq";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    }

    const tenantId = user.app_metadata?.tenant_id;
    if (!tenantId) {
      return NextResponse.json({ error: "חסר tenant" }, { status: 400 });
    }

    const { campaignId } = await request.json();

    // Resume campaign
    const { data: campaign, error } = await supabase
      .from("campaigns")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("tenant_id", tenantId)
      .eq("status", "paused")
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: "שגיאה בחידוש הקמפיין" }, { status: 500 });
    }

    // Re-enqueue pending contacts
    const { data: pendingContacts } = await supabase
      .from("campaign_contacts")
      .select("id, contact_id")
      .eq("campaign_id", campaignId)
      .eq("tenant_id", tenantId)
      .in("status", ["pending", "no_answer"]);

    if (pendingContacts && pendingContacts.length > 0) {
      const queue = getCallQueue();
      const jobs = pendingContacts.map((cc) => ({
        name: `call-${campaignId}-${cc.contact_id}`,
        data: {
          tenantId,
          campaignId,
          contactId: cc.contact_id,
          campaignContactId: cc.id,
        },
      }));
      await queue.addBulk(jobs);
    }

    return NextResponse.json({ campaign, reenqueued: pendingContacts?.length ?? 0 });
  } catch (err) {
    console.error("Resume error:", err);
    return NextResponse.json({ error: "שגיאה" }, { status: 500 });
  }
}
