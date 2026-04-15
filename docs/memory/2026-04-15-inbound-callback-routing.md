# 2026-04-15 Inbound Callback Routing (DID-first)

## Context

Goal was to support "call the agent back" for inbound calls while preserving tenant isolation and avoiding brittle env-based routing.

## What was implemented

- Added inbound-capable schema migration: `supabase/migrations/004_inbound_calls.sql`
  - Created `public.phone_numbers`:
    - `tenant_id` (FK), unique `phone_number`, optional `default_campaign_id` (FK).
    - RLS policies for tenant-scoped CRUD.
  - Added `is_system_default boolean` to:
    - `public.tenants`
    - `public.campaigns`
  - Added unique partial indexes to enforce a single system default:
    - `idx_tenants_system_default_true`
    - `idx_campaigns_system_default_true`
  - Added `calls.direction` with check constraint:
    - `outbound | inbound`
  - Made `calls.campaign_contact_id` nullable for inbound-originated calls.

- Updated inbound runtime routing in `voiceagent-saas/server.js`:
  - Imported and used `CallBridge` directly for inbound flow.
  - Added DID and caller helpers:
    - `buildPhoneCandidates(...)`
    - `parseDidCandidatesFromChannel(...)`
    - `findPhoneNumberRoute(...)`
    - `findOrCreateInboundContact(...)`
    - `resolveInboundCampaignId(...)`
    - `getSystemDefaultRoute(...)`
  - Added `handleInboundCall(channel)`:
    - Triggered from `StasisStart` when channel is Voicenter customer leg but no outbound match exists.
    - Routing order:
      1. DID route via `phone_numbers`.
      2. Contact lookup within resolved tenant.
      3. Known caller -> last campaign from `calls`.
      4. Unknown caller -> `phone_numbers.default_campaign_id`.
      5. No DID route -> system default tenant/campaign (`is_system_default=true`).
    - Creates inbound `calls` row with:
      - `direction='inbound'`
      - `campaign_contact_id=null`
      - pinned `agent_id_used` and `sync_version_used`
    - Builds and starts `CallBridge` for inbound call.
    - Calls `bridge.handleCustomerAnswered()` immediately after setup.
  - Added inbound safety guards:
    - `inboundChannelsInFlight` dedupe set (prevents duplicate handling per ARI channel).
    - ARI race-safe `try/catch` around answer/bridge actions.
    - Graceful hangup on unresolved route / missing campaign readiness.
  - Made `supabaseAdmin` always available at boot (not only when `REDIS_URL` is set), so inbound routing can query DB in gateway-only mode.

## Verification run

- Syntax:
  - `node --check voiceagent-saas/server.js` -> passed
- Lints:
  - `ReadLints` on edited files -> no linter errors

## Migration execution (remote Supabase)

- Attempted standard migration push:
  - `npx supabase db push`
  - Blocked because remote migration history did not align with local filenames (CLI skipped old files and requested repair/pull flow).

- Applied migration SQL directly to linked remote project:
  - `npx supabase db query --linked -f supabase/migrations/004_inbound_calls.sql`
  - Result: executed successfully.

- Verified applied objects:
  - Queried `information_schema.columns` for `public.phone_numbers`.
  - Confirmed expected columns exist:
    - `id`, `tenant_id`, `phone_number`, `default_campaign_id`, `created_at`, `updated_at`.

## Operational notes

- Since migration was applied via `db query` and not `db push`, `supabase_migrations.schema_migrations` does not automatically track this file.
- If strict CLI migration tracking is required later, follow up with migration history repair/pull alignment before regular `db push` usage.
- Runtime still needs data seeding to fully route fallback traffic:
  1. Insert at least one row in `phone_numbers`.
  2. Mark one tenant as system default.
  3. Mark one campaign (for that tenant) as system default.
