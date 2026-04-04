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

    const body = await request.json();
    const {
      name,
      script,
      questions,
      whatsapp_followup_template,
      whatsapp_followup_link,
      template_id,
      schedule_days,
      schedule_windows,
      max_concurrent_calls,
      max_retry_attempts,
      retry_delay_minutes,
      contact_ids,
    } = body;

    if (!name || !script || !contact_ids?.length) {
      return NextResponse.json({ error: "חסרים שדות חובה" }, { status: 400 });
    }

    // Create campaign
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        tenant_id: tenantId,
        name,
        script,
        questions: questions ?? [],
        whatsapp_followup_template: whatsapp_followup_template ?? null,
        whatsapp_followup_link: whatsapp_followup_link ?? null,
        template_id: template_id ?? null,
        schedule_days: schedule_days ?? ["sun", "mon", "tue", "wed", "thu"],
        schedule_windows: schedule_windows ?? [{ start: "10:00", end: "13:00" }, { start: "16:00", end: "19:00" }],
        max_concurrent_calls: max_concurrent_calls ?? 5,
        max_retry_attempts: max_retry_attempts ?? 2,
        retry_delay_minutes: retry_delay_minutes ?? 120,
        status: "active",
      })
      .select()
      .single();

    if (campaignError) {
      console.error("Campaign create error:", campaignError);
      return NextResponse.json({ error: "שגיאה ביצירת הקמפיין" }, { status: 500 });
    }

    // Enroll contacts into campaign
    const enrollRows = contact_ids.map((contactId: string) => ({
      campaign_id: campaign.id,
      contact_id: contactId,
      tenant_id: tenantId,
    }));

    const { data: enrolled, error: enrollError } = await supabase
      .from("campaign_contacts")
      .upsert(enrollRows, { onConflict: "tenant_id,contact_id,campaign_id" })
      .select("id, contact_id");

    if (enrollError) {
      console.error("Enroll error:", enrollError);
      return NextResponse.json({ error: "שגיאה ברישום אנשי הקשר" }, { status: 500 });
    }

    // Enqueue BullMQ jobs for each campaign contact
    const queue = getCallQueue();
    const jobs = (enrolled ?? []).map((cc) => ({
      name: `call-${campaign.id}-${cc.contact_id}`,
      data: {
        tenantId,
        campaignId: campaign.id,
        contactId: cc.contact_id,
        campaignContactId: cc.id,
      },
    }));

    if (jobs.length > 0) {
      await queue.addBulk(jobs);
    }

    return NextResponse.json({ campaignId: campaign.id, contactsEnqueued: jobs.length });
  } catch (err) {
    console.error("Launch error:", err);
    return NextResponse.json({ error: "שגיאה בהפעלת הקמפיין" }, { status: 500 });
  }
}
