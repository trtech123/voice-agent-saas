import { describe, expect, it, vi } from "vitest";
import { ingestCampaignLeadWebhook } from "@/lib/webhooks/lead-intake";
import { hashWebhookSecret } from "@/lib/webhooks/secret";

describe("ingestCampaignLeadWebhook", () => {
  it("accepts a valid lead and enqueues exactly one job", async () => {
    const enqueueCall = vi.fn().mockResolvedValue(undefined);
    const getByPhone = vi.fn().mockResolvedValue(null);
    const upsertOne = vi.fn().mockResolvedValue({
      id: "contact-1",
      custom_fields: {},
      is_dnc: false,
      dnc_at: null,
      dnc_source: null,
      name: "New Lead",
      email: "lead@example.com",
    });
    const getByCampaignAndContact = vi.fn().mockResolvedValue(null);
    const insertCampaignContact = vi.fn().mockResolvedValue({ id: "cc-1" });
    const log = vi.fn().mockResolvedValue(undefined);

    const result = await ingestCampaignLeadWebhook(
      "campaign-1",
      "super-secret",
      {
        phone: "0501234567",
        name: "New Lead",
        email: "lead@example.com",
        source: "make_facebook_ads",
        customFields: { ad_name: "Summer Promo" },
      },
      {
        getCampaign: vi.fn().mockResolvedValue({
          id: "campaign-1",
          tenant_id: "tenant-1",
          name: "Inbound Campaign",
          status: "active",
          webhook_enabled: true,
          webhook_secret_hash: hashWebhookSecret("super-secret"),
          webhook_source_label: "Facebook Lead Ads",
        }),
        makeTenantDal: () => ({
          contacts: { getByPhone, upsertOne },
          campaignContacts: { getByCampaignAndContact },
          auditLog: { log },
          insertCampaignContact,
        }),
        enqueueCall,
      }
    );

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      status: "accepted",
      reason: "enqueued",
      enqueued: true,
      contactId: "contact-1",
      campaignContactId: "cc-1",
      phone: "972501234567",
    });
    expect(enqueueCall).toHaveBeenCalledTimes(1);
    expect(insertCampaignContact).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid secrets", async () => {
    const log = vi.fn().mockResolvedValue(undefined);

    const result = await ingestCampaignLeadWebhook(
      "campaign-1",
      "wrong-secret",
      { phone: "0501234567" },
      {
        getCampaign: vi.fn().mockResolvedValue({
          id: "campaign-1",
          tenant_id: "tenant-1",
          name: "Inbound Campaign",
          status: "active",
          webhook_enabled: true,
          webhook_secret_hash: hashWebhookSecret("super-secret"),
          webhook_source_label: "Facebook Lead Ads",
        }),
        makeTenantDal: () => ({
          contacts: { getByPhone: vi.fn(), upsertOne: vi.fn() },
          campaignContacts: { getByCampaignAndContact: vi.fn() },
          auditLog: { log },
          insertCampaignContact: vi.fn(),
        }),
        enqueueCall: vi.fn(),
      }
    );

    expect(result.httpStatus).toBe(401);
    expect(result.body).toMatchObject({
      status: "rejected",
      reason: "invalid_secret",
    });
  });

  it("rejects invalid phone numbers without creating records", async () => {
    const upsertOne = vi.fn();
    const insertCampaignContact = vi.fn();

    const result = await ingestCampaignLeadWebhook(
      "campaign-1",
      "super-secret",
      { phone: "12345" },
      {
        getCampaign: vi.fn().mockResolvedValue({
          id: "campaign-1",
          tenant_id: "tenant-1",
          name: "Inbound Campaign",
          status: "active",
          webhook_enabled: true,
          webhook_secret_hash: hashWebhookSecret("super-secret"),
          webhook_source_label: "Facebook Lead Ads",
        }),
        makeTenantDal: () => ({
          contacts: { getByPhone: vi.fn(), upsertOne },
          campaignContacts: { getByCampaignAndContact: vi.fn() },
          auditLog: { log: vi.fn().mockResolvedValue(undefined) },
          insertCampaignContact,
        }),
        enqueueCall: vi.fn(),
      }
    );

    expect(result.httpStatus).toBe(400);
    expect(result.body).toMatchObject({
      status: "rejected",
      reason: "invalid_phone",
    });
    expect(upsertOne).not.toHaveBeenCalled();
    expect(insertCampaignContact).not.toHaveBeenCalled();
  });

  it("reuses an existing enrollment without creating a duplicate", async () => {
    const enqueueCall = vi.fn();
    const getByCampaignAndContact = vi.fn().mockResolvedValue({
      id: "cc-existing",
      status: "pending",
    });

    const result = await ingestCampaignLeadWebhook(
      "campaign-1",
      "super-secret",
      { phone: "0501234567" },
      {
        getCampaign: vi.fn().mockResolvedValue({
          id: "campaign-1",
          tenant_id: "tenant-1",
          name: "Inbound Campaign",
          status: "active",
          webhook_enabled: true,
          webhook_secret_hash: hashWebhookSecret("super-secret"),
          webhook_source_label: "Facebook Lead Ads",
        }),
        makeTenantDal: () => ({
          contacts: {
            getByPhone: vi.fn().mockResolvedValue({
              id: "contact-1",
              custom_fields: {},
              is_dnc: false,
              dnc_at: null,
              dnc_source: null,
              name: null,
              email: null,
            }),
            upsertOne: vi.fn().mockResolvedValue({
              id: "contact-1",
              custom_fields: {},
              is_dnc: false,
              dnc_at: null,
              dnc_source: null,
              name: null,
              email: null,
            }),
          },
          campaignContacts: { getByCampaignAndContact },
          auditLog: { log: vi.fn().mockResolvedValue(undefined) },
          insertCampaignContact: vi.fn(),
        }),
        enqueueCall,
      }
    );

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      status: "accepted",
      reason: "already_enrolled",
      enqueued: false,
      campaignContactId: "cc-existing",
    });
    expect(enqueueCall).not.toHaveBeenCalled();
  });
});
