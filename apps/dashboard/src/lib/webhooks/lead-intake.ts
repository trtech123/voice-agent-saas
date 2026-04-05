import { AuditLogDAL, CampaignContactDAL, ContactDAL, type Database } from "@vam/database";
import { normalizeIsraeliPhone } from "@/lib/utils/phone-validator";
import { WEBHOOK_SECRET_HEADER } from "@/lib/webhooks/constants";
import { verifyWebhookSecret } from "@/lib/webhooks/secret";

type CampaignWebhookRow = Pick<
  Database["public"]["Tables"]["campaigns"]["Row"],
  | "id"
  | "tenant_id"
  | "name"
  | "status"
  | "webhook_enabled"
  | "webhook_secret_hash"
  | "webhook_source_label"
>;

export interface IncomingWebhookLeadPayload {
  phone?: string;
  name?: string;
  email?: string;
  source?: string;
  receivedAt?: string;
  externalLeadId?: string;
  customFields?: Record<string, unknown>;
}

export interface LeadIntakeDependencies {
  getCampaign: (campaignId: string) => Promise<CampaignWebhookRow | null>;
  makeTenantDal: (tenantId: string) => {
    contacts: Pick<ContactDAL, "getByPhone" | "upsertOne">;
    campaignContacts: Pick<CampaignContactDAL, "getByCampaignAndContact">;
    auditLog: Pick<AuditLogDAL, "log">;
    insertCampaignContact: (args: {
      campaignId: string;
      contactId: string;
      tenantId: string;
    }) => Promise<{ id: string }>;
  };
  enqueueCall: (data: {
    tenantId: string;
    campaignId: string;
    contactId: string;
    campaignContactId: string;
  }) => Promise<void>;
  now?: () => string;
}

export interface LeadIntakeResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildLeadSourceFields(
  payload: Required<Pick<IncomingWebhookLeadPayload, "source">> &
    Pick<IncomingWebhookLeadPayload, "receivedAt" | "externalLeadId">,
  now: string
) {
  return {
    webhook_source: payload.source,
    webhook_received_at: payload.receivedAt ?? null,
    webhook_external_lead_id: payload.externalLeadId ?? null,
    webhook_last_ingested_at: now,
  };
}

export async function ingestCampaignLeadWebhook(
  campaignId: string,
  headerSecret: string | null,
  rawPayload: unknown,
  deps: LeadIntakeDependencies
): Promise<LeadIntakeResult> {
  const campaign = await deps.getCampaign(campaignId);
  if (!campaign) {
    return {
      httpStatus: 404,
      body: { status: "rejected", reason: "campaign_not_found" },
    };
  }

  const tenantDal = deps.makeTenantDal(campaign.tenant_id);

  if (!campaign.webhook_enabled) {
    await tenantDal.auditLog.log("webhook_lead_rejected", "campaign", campaign.id, {
      reason: "webhook_disabled",
    });
    return {
      httpStatus: 409,
      body: { status: "rejected", reason: "webhook_disabled" },
    };
  }

  if (!headerSecret || !verifyWebhookSecret(headerSecret, campaign.webhook_secret_hash)) {
    await tenantDal.auditLog.log("webhook_lead_rejected", "campaign", campaign.id, {
      reason: "invalid_secret",
      headerName: WEBHOOK_SECRET_HEADER,
    });
    return {
      httpStatus: 401,
      body: { status: "rejected", reason: "invalid_secret" },
    };
  }

  if (!isRecord(rawPayload)) {
    await tenantDal.auditLog.log("webhook_lead_rejected", "campaign", campaign.id, {
      reason: "invalid_payload",
    });
    return {
      httpStatus: 400,
      body: { status: "rejected", reason: "invalid_payload" },
    };
  }

  const payload = rawPayload as IncomingWebhookLeadPayload;
  if (!payload.phone || typeof payload.phone !== "string") {
    await tenantDal.auditLog.log("webhook_lead_rejected", "campaign", campaign.id, {
      reason: "missing_phone",
    });
    return {
      httpStatus: 400,
      body: { status: "rejected", reason: "missing_phone" },
    };
  }

  const normalizedPhone = normalizeIsraeliPhone(payload.phone);
  if (!normalizedPhone) {
    await tenantDal.auditLog.log("webhook_lead_rejected", "campaign", campaign.id, {
      reason: "invalid_phone",
      phone: payload.phone,
    });
    return {
      httpStatus: 400,
      body: { status: "rejected", reason: "invalid_phone" },
    };
  }

  if (campaign.status !== "active") {
    await tenantDal.auditLog.log("webhook_lead_rejected", "campaign", campaign.id, {
      reason: "campaign_not_active",
    });
    return {
      httpStatus: 409,
      body: { status: "rejected", reason: "campaign_not_active" },
    };
  }

  const existingContact = await tenantDal.contacts.getByPhone(normalizedPhone);
  const now = deps.now?.() ?? new Date().toISOString();
  const source =
    payload.source?.trim() || campaign.webhook_source_label?.trim() || "make_facebook_ads";
  const sourceFields = buildLeadSourceFields({
    source,
    receivedAt: payload.receivedAt,
    externalLeadId: payload.externalLeadId,
  }, now);
  const mergedCustomFields = {
    ...(existingContact?.custom_fields ?? {}),
    ...(isRecord(payload.customFields) ? payload.customFields : {}),
    ...sourceFields,
  };

  const contact = await tenantDal.contacts.upsertOne({
    phone: normalizedPhone,
    name: payload.name?.trim() || existingContact?.name || null,
    email: payload.email?.trim() || existingContact?.email || null,
    custom_fields: mergedCustomFields,
    is_dnc: existingContact?.is_dnc ?? false,
    dnc_at: existingContact?.dnc_at ?? null,
    dnc_source: existingContact?.dnc_source ?? null,
  });

  const existingCampaignContact = await tenantDal.campaignContacts.getByCampaignAndContact(
    campaign.id,
    contact.id
  );

  if (existingCampaignContact) {
    await tenantDal.auditLog.log("webhook_lead_received", "campaign", campaign.id, {
      contactId: contact.id,
      campaignContactId: existingCampaignContact.id,
      source,
      enqueued: false,
      reason: "already_enrolled",
    });
    return {
      httpStatus: 200,
      body: {
        status: "accepted",
        reason: "already_enrolled",
        enqueued: false,
        contactId: contact.id,
        campaignContactId: existingCampaignContact.id,
      },
    };
  }

  const campaignContact = await tenantDal.insertCampaignContact({
    campaignId: campaign.id,
    contactId: contact.id,
    tenantId: campaign.tenant_id,
  });

  await deps.enqueueCall({
    tenantId: campaign.tenant_id,
    campaignId: campaign.id,
    contactId: contact.id,
    campaignContactId: campaignContact.id,
  });

  await tenantDal.auditLog.log("webhook_lead_received", "campaign", campaign.id, {
    contactId: contact.id,
    campaignContactId: campaignContact.id,
    source,
    enqueued: true,
  });

  return {
    httpStatus: 200,
    body: {
      status: "accepted",
      reason: "enqueued",
      enqueued: true,
      contactId: contact.id,
      campaignContactId: campaignContact.id,
      phone: normalizedPhone,
    },
  };
}
