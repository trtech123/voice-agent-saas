alter table public.campaigns
  add column webhook_enabled boolean not null default false,
  add column webhook_secret_hash text,
  add column webhook_source_label text,
  add column webhook_payload_example jsonb,
  add column webhook_last_rotated_at timestamptz;

comment on column public.campaigns.webhook_enabled is 'Whether inbound lead webhooks are accepted for this campaign.';
comment on column public.campaigns.webhook_secret_hash is 'Hashed secret used to authenticate inbound webhook requests.';
comment on column public.campaigns.webhook_source_label is 'Human-readable label for the upstream lead source.';
comment on column public.campaigns.webhook_payload_example is 'Optional JSON example payload shown in the dashboard for integrations like Make.com.';
comment on column public.campaigns.webhook_last_rotated_at is 'When the webhook secret was last rotated.';

update public.campaigns
set
  webhook_source_label = coalesce(webhook_source_label, 'Facebook Lead Ads'),
  webhook_payload_example = coalesce(
    webhook_payload_example,
    '{
      "phone": "0501234567",
      "name": "ישראל ישראלי",
      "email": "lead@example.com",
      "source": "make_facebook_ads",
      "externalLeadId": "fb-lead-123",
      "customFields": {
        "campaign_name": "Spring Promo",
        "adset_name": "Lookalike 1%"
      }
    }'::jsonb
  );
