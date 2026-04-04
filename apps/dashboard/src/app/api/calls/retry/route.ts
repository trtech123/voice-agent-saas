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

    const { callId, campaignId, contactId, campaignContactId } = await request.json();

    // Reset the call status
    const { error: callError } = await supabase
      .from("calls")
      .update({ status: "initiated", failure_reason: null })
      .eq("id", callId)
      .eq("tenant_id", tenantId);

    if (callError) {
      return NextResponse.json({ error: "שגיאה באיפוס השיחה" }, { status: 500 });
    }

    // Reset campaign contact status
    const { error: ccError } = await supabase
      .from("campaign_contacts")
      .update({ status: "queued" })
      .eq("id", campaignContactId)
      .eq("tenant_id", tenantId);

    if (ccError) {
      return NextResponse.json({ error: "שגיאה באיפוס איש הקשר" }, { status: 500 });
    }

    // Re-enqueue the job
    const queue = getCallQueue();
    await queue.add(`retry-${callId}`, {
      tenantId,
      campaignId,
      contactId,
      campaignContactId,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Retry error:", err);
    return NextResponse.json({ error: "שגיאה" }, { status: 500 });
  }
}
