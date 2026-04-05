export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

export const DEFAULT_WEBHOOK_PAYLOAD_EXAMPLE = {
  phone: "0501234567",
  name: "ישראל ישראלי",
  email: "lead@example.com",
  source: "make_facebook_ads",
  externalLeadId: "fb-lead-123",
  customFields: {
    campaign_name: "Spring Promo",
    adset_name: "Lookalike 1%",
  },
};
