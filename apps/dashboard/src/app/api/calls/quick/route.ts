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

    const { phoneNumber, contactName, campaignId } = await request.json();

    if (!phoneNumber || !campaignId) {
      return NextResponse.json(
        { error: "חסר מספר טלפון או קמפיין" },
        { status: 400 }
      );
    }

    const normalized = normalizeIsraeliPhone(phoneNumber);
    if (!normalized) {
      return NextResponse.json(
        { error: "מספר טלפון לא תקין" },
        { status: 400 }
      );
    }

    // Verify campaign belongs to tenant
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .select("id, name")
      .eq("id", campaignId)
      .eq("tenant_id", tenantId)
      .single();

    if (campaignError || !campaign) {
      return NextResponse.json(
        { error: "קמפיין לא נמצא" },
        { status: 404 }
      );
    }

    // Upsert contact by phone + tenant
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .upsert(
        {
          tenant_id: tenantId,
          phone: normalized,
          name: contactName || "שיחה מהירה",
        },
        { onConflict: "tenant_id,phone" }
      )
      .select("id")
      .single();

    if (contactError) {
      console.error("Quick call contact error:", contactError);
      return NextResponse.json(
        { error: "שגיאה ביצירת איש קשר" },
        { status: 500 }
      );
    }

    // Upsert campaign_contact entry (may already exist from previous calls)
    const { data: cc, error: ccError } = await supabase
      .from("campaign_contacts")
      .upsert(
        {
          campaign_id: campaign.id,
          contact_id: contact.id,
          tenant_id: tenantId,
          status: "pending",
        },
        { onConflict: "tenant_id,contact_id,campaign_id" }
      )
      .select("id")
      .single();

    if (ccError) {
      console.error("Quick call enroll error:", ccError);
      return NextResponse.json(
        { error: "שגיאה ברישום איש קשר לקמפיין" },
        { status: 500 }
      );
    }

    // Enqueue the BullMQ call job
    const queue = getCallQueue();
    await queue.add(`quick-call-${campaign.id}-${contact.id}`, {
      tenantId,
      campaignId: campaign.id,
      contactId: contact.id,
      campaignContactId: cc.id,
    });

    return NextResponse.json({
      success: true,
      message: "השיחה בתור",
      contactId: contact.id,
      campaignContactId: cc.id,
    });
  } catch (err) {
    console.error("Quick call error:", err);
    return NextResponse.json(
      { error: "שגיאה בשליחת שיחה מהירה" },
      { status: 500 }
    );
  }
}
