import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { normalizeIsraeliPhone } from "@/lib/utils/phone-validator";
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

    const { phone, script, questions } = await request.json();

    const normalized = normalizeIsraeliPhone(phone);
    if (!normalized) {
      return NextResponse.json({ error: "מספר טלפון לא תקין" }, { status: 400 });
    }

    // Upsert a test contact
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .upsert(
        { tenant_id: tenantId, phone: normalized, name: "שיחת בדיקה" },
        { onConflict: "tenant_id,phone" }
      )
      .select("id")
      .single();

    if (contactError) {
      console.error("Test contact error:", contactError);
      return NextResponse.json({ error: "שגיאה ביצירת איש קשר" }, { status: 500 });
    }

    // Create a test campaign (draft, won't be listed prominently)
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        tenant_id: tenantId,
        name: `שיחת בדיקה — ${new Date().toLocaleString("he-IL")}`,
        script: script ?? "",
        questions: questions ?? [],
        whatsapp_followup_template: null,
        whatsapp_followup_link: null,
        template_id: null,
        schedule_days: [],
        schedule_windows: [],
        max_concurrent_calls: 1,
        max_retry_attempts: 0,
        retry_delay_minutes: 0,
        status: "draft",
      })
      .select("id")
      .single();

    if (campaignError) {
      console.error("Test campaign error:", campaignError);
      return NextResponse.json({ error: "שגיאה ביצירת קמפיין בדיקה" }, { status: 500 });
    }

    // Enroll test contact
    const { data: cc, error: ccError } = await supabase
      .from("campaign_contacts")
      .insert({
        campaign_id: campaign.id,
        contact_id: contact.id,
        tenant_id: tenantId,
      })
      .select("id")
      .single();

    if (ccError) {
      console.error("Test enroll error:", ccError);
      return NextResponse.json({ error: "שגיאה ברישום" }, { status: 500 });
    }

    // Enqueue a single call job
    const queue = getCallQueue();
    await queue.add(`test-call-${campaign.id}`, {
      tenantId,
      campaignId: campaign.id,
      contactId: contact.id,
      campaignContactId: cc.id,
    });

    return NextResponse.json({ success: true, campaignId: campaign.id });
  } catch (err) {
    console.error("Test call error:", err);
    return NextResponse.json({ error: "שגיאה בשליחת שיחת בדיקה" }, { status: 500 });
  }
}
