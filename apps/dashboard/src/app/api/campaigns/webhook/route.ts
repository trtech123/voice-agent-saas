import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { DEFAULT_WEBHOOK_PAYLOAD_EXAMPLE } from "@/lib/webhooks/constants";
import { generateWebhookSecret, hashWebhookSecret } from "@/lib/webhooks/secret";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    }

    const tenantId = user.app_metadata?.tenant_id;
    if (!tenantId) {
      return NextResponse.json({ error: "חסר tenant" }, { status: 400 });
    }

    const body = await request.json();
    const campaignId = typeof body.campaignId === "string" ? body.campaignId : "";
    const action = body.action === "rotate" ? "rotate" : "update";

    if (!campaignId) {
      return NextResponse.json({ error: "חסר campaignId" }, { status: 400 });
    }

    const { data: existingCampaign, error: existingCampaignError } = await supabase
      .from("campaigns")
      .select("id, webhook_secret_hash")
      .eq("id", campaignId)
      .eq("tenant_id", tenantId)
      .single();

    if (existingCampaignError || !existingCampaign) {
      return NextResponse.json({ error: "קמפיין לא נמצא" }, { status: 404 });
    }

    if (action === "rotate") {
      const secret = generateWebhookSecret();
      const { data: campaign, error } = await supabase
        .from("campaigns")
        .update({
          webhook_enabled: true,
          webhook_secret_hash: hashWebhookSecret(secret),
          webhook_source_label:
            typeof body.webhookSourceLabel === "string" && body.webhookSourceLabel.trim()
              ? body.webhookSourceLabel.trim()
              : "Facebook Lead Ads",
          webhook_payload_example: DEFAULT_WEBHOOK_PAYLOAD_EXAMPLE,
          webhook_last_rotated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as any)
        .eq("id", campaignId)
        .eq("tenant_id", tenantId)
        .select("*")
        .single();

      if (error || !campaign) {
        return NextResponse.json({ error: "שגיאה ביצירת Secret" }, { status: 500 });
      }

      return NextResponse.json({
        campaign,
        secret,
      });
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (typeof body.webhookEnabled === "boolean") {
      if (body.webhookEnabled && !existingCampaign.webhook_secret_hash) {
        return NextResponse.json({ error: "צריך ליצור Secret לפני שמפעילים את הוובהוק" }, { status: 400 });
      }
      updates.webhook_enabled = body.webhookEnabled;
    }

    if (typeof body.webhookSourceLabel === "string") {
      updates.webhook_source_label = body.webhookSourceLabel.trim() || "Facebook Lead Ads";
    }

    if (body.webhookPayloadExample && typeof body.webhookPayloadExample === "object") {
      updates.webhook_payload_example = body.webhookPayloadExample;
    }

    const { data: campaign, error } = await supabase
      .from("campaigns")
      .update(updates as any)
      .eq("id", campaignId)
      .eq("tenant_id", tenantId)
      .select("*")
      .single();

    if (error || !campaign) {
      return NextResponse.json({ error: "שגיאה בעדכון הוובהוק" }, { status: 500 });
    }

    return NextResponse.json({ campaign });
  } catch (error) {
    console.error("Campaign webhook config error:", error);
    return NextResponse.json({ error: "שגיאה בעדכון הוובהוק" }, { status: 500 });
  }
}
