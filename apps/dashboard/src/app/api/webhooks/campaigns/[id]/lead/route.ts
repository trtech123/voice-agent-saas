import { NextRequest, NextResponse } from "next/server";
import { AuditLogDAL, CampaignContactDAL, ContactDAL } from "@vam/database";
import { getCallQueue } from "@/lib/bullmq";
import { createAdminClient } from "@/lib/supabase-admin";
import { ingestCampaignLeadWebhook } from "@/lib/webhooks/lead-intake";
import { WEBHOOK_SECRET_HEADER } from "@/lib/webhooks/constants";

interface RouteContext {
  params: {
    id: string;
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const supabase = createAdminClient();
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json(
        {
          status: "rejected",
          reason: "invalid_payload",
        },
        { status: 400 }
      );
    }
    const secret = request.headers.get(WEBHOOK_SECRET_HEADER);

    const result = await ingestCampaignLeadWebhook(context.params.id, secret, payload, {
      getCampaign: async (campaignId) => {
        const { data } = await supabase
          .from("campaigns")
          .select(
            "id, tenant_id, name, status, webhook_enabled, webhook_secret_hash, webhook_source_label"
          )
          .eq("id", campaignId)
          .single();

        return data;
      },
      makeTenantDal: (tenantId) => {
        const contacts = new ContactDAL(supabase, tenantId);
        const campaignContacts = new CampaignContactDAL(supabase, tenantId);
        const auditLog = new AuditLogDAL(supabase, tenantId);

        return {
          contacts,
          campaignContacts,
          auditLog,
          insertCampaignContact: async ({ campaignId, contactId, tenantId: rowTenantId }) => {
            const { data, error } = await supabase
              .from("campaign_contacts")
              .insert({
                campaign_id: campaignId,
                contact_id: contactId,
                tenant_id: rowTenantId,
              } as any)
              .select("id")
              .single();

            if (error || !data) {
              throw error ?? new Error("Failed to create campaign contact");
            }

            return data;
          },
        };
      },
      enqueueCall: async (data) => {
        const queue = getCallQueue();
        await queue.add(`webhook-call-${data.campaignId}-${data.contactId}`, data);
      },
    });

    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (error) {
    console.error("Webhook lead intake error:", error);
    return NextResponse.json(
      {
        status: "rejected",
        reason: "internal_error",
      },
      { status: 500 }
    );
  }
}
