-- 2026-04-07_elevenlabs_runtime_swap.sql
-- Spec: docs/superpowers/specs/2026-04-07-elevenlabs-runtime-swap-design.md
-- Plan: docs/superpowers/plans/2026-04-07-elevenlabs-runtime-swap-plan.md (task T1)
--
-- Single-transaction, idempotent migration for the ElevenLabs runtime swap.
-- - Creates enums, adds columns to tenants/campaigns/calls/campaign_contacts
-- - Creates call_turns, call_tool_invocations, webhook_events, platform_settings, call_metrics
-- - Seeds platform_settings.default_tts_model (NOT default_voice_id — user must pick)
-- - Adds BEFORE INSERT trigger on campaigns to default tts_model only
-- - Creates private call-recordings storage bucket (50 MB cap)
-- - Non-destructive, rollback-safe

begin;

create extension if not exists "pgcrypto";

-- ============================================================
-- ENUMS (idempotent, pre-PG15 safe)
-- ============================================================
do $$ begin
  create type agent_status_t as enum ('pending', 'provisioning', 'ready', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type llm_provider_t as enum ('bundled', 'gpt-4o', 'claude-sonnet-4.5');
exception when duplicate_object then null; end $$;

do $$ begin
  create type audio_archive_status_t as enum ('pending', 'archived', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type call_failure_reason_t as enum (
    'voicenter_busy',
    'el_ws_connect_failed',
    'el_ws_dropped',
    'agent_not_ready',
    'agent_version_mismatch',
    'no_answer',
    'network_error',
    'dnc_listed',
    'invalid_number',
    'compliance_block',
    'abandoned_by_callee',
    'janitor_finalized',
    'webhook_timeout',
    'el_quota_exceeded',
    'max_duration_exceeded'
  );
exception when duplicate_object then null; end $$;

-- ============================================================
-- PLATFORM_SETTINGS (must exist + be seeded BEFORE campaigns.tts_model backfill)
-- ============================================================
create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

insert into public.platform_settings (key, value)
values ('default_tts_model', '"eleven_turbo_v2_5"'::jsonb)
on conflict (key) do nothing;

alter table public.platform_settings enable row level security;

-- ============================================================
-- TENANTS — new columns
-- ============================================================
alter table public.tenants
  add column if not exists llm_provider llm_provider_t not null default 'bundled',
  add column if not exists llm_api_key_encrypted bytea,
  add column if not exists llm_api_key_last4 text,
  add column if not exists llm_api_key_validated_at timestamptz,
  add column if not exists feature_flags jsonb not null default '{}'::jsonb;

-- ============================================================
-- CAMPAIGNS — new columns
-- ============================================================
alter table public.campaigns
  add column if not exists elevenlabs_agent_id text,
  add column if not exists external_ref uuid not null default gen_random_uuid(),
  add column if not exists agent_status agent_status_t not null default 'pending',
  add column if not exists agent_sync_error text,
  add column if not exists agent_synced_at timestamptz,
  add column if not exists sync_version bigint not null default 0,
  add column if not exists voice_id text,             -- stays nullable forever; user must pick
  add column if not exists el_etag text;

-- tts_model: add nullable → backfill → SET NOT NULL (order is load-bearing)
alter table public.campaigns add column if not exists tts_model text;

update public.campaigns
set tts_model = (
  select trim(both '"' from value::text)
  from public.platform_settings
  where key = 'default_tts_model'
)
where tts_model is null;

alter table public.campaigns alter column tts_model set not null;

-- BEFORE INSERT trigger: fill tts_model from platform_settings if NULL.
-- Does NOT touch voice_id (user must pick via Spec B).
create or replace function public.campaigns_fill_defaults()
returns trigger
language plpgsql
as $$
begin
  if new.tts_model is null then
    select trim(both '"' from value::text)
      into new.tts_model
      from public.platform_settings
      where key = 'default_tts_model';
  end if;
  return new;
end;
$$;

drop trigger if exists campaigns_fill_defaults_trg on public.campaigns;
create trigger campaigns_fill_defaults_trg
  before insert on public.campaigns
  for each row execute function public.campaigns_fill_defaults();

-- ============================================================
-- CALLS — new columns (started_at/ended_at already exist per 001)
-- ============================================================
alter table public.calls
  add column if not exists elevenlabs_conversation_id text unique,
  add column if not exists transcript_full jsonb,
  add column if not exists summary text,
  add column if not exists sentiment text,
  add column if not exists success_evaluation jsonb,
  add column if not exists audio_storage_path text,
  add column if not exists audio_archive_status audio_archive_status_t,
  add column if not exists failure_reason_t call_failure_reason_t,
  add column if not exists retry_count int not null default 0,
  add column if not exists last_retry_day date,
  add column if not exists webhook_processed_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists agent_id_used text,
  add column if not exists sync_version_used bigint;

-- Note: calls.failure_reason already exists as text in 001. The spec requires a
-- call_failure_reason_t enum; we add it as failure_reason_t alongside to avoid a
-- destructive type change on the existing text column.

-- ============================================================
-- CAMPAIGN_CONTACTS — new columns
-- ============================================================
alter table public.campaign_contacts
  add column if not exists last_retry_day date,
  add column if not exists daily_retry_count int not null default 0;

-- ============================================================
-- CALL_TURNS
-- ============================================================
create table if not exists public.call_turns (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  turn_index int not null,
  role text not null check (role in ('user', 'agent')),
  text text,
  is_final boolean not null default true,
  ts timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint call_turns_call_turn_unique unique (call_id, turn_index)
);

create index if not exists idx_call_turns_call_turn on public.call_turns(call_id, turn_index);
create index if not exists idx_call_turns_tenant on public.call_turns(tenant_id);

alter table public.call_turns enable row level security;

create policy "call_turns_select" on public.call_turns
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ============================================================
-- CALL_TOOL_INVOCATIONS
-- ============================================================
create table if not exists public.call_tool_invocations (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  args jsonb,
  result jsonb,
  is_error boolean not null default false,
  started_at timestamptz not null,
  ended_at timestamptz,
  latency_ms int generated always as (
    case
      when ended_at is not null and started_at is not null
      then (extract(epoch from (ended_at - started_at)) * 1000)::int
      else null
    end
  ) stored,
  created_at timestamptz not null default now(),
  constraint call_tool_invocations_idem unique (call_id, name, started_at)
);

create index if not exists idx_cti_tenant_name_started
  on public.call_tool_invocations(tenant_id, name, started_at desc);
create index if not exists idx_cti_call on public.call_tool_invocations(call_id);

alter table public.call_tool_invocations enable row level security;

create policy "call_tool_invocations_select" on public.call_tool_invocations
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ============================================================
-- WEBHOOK_EVENTS
-- ============================================================
create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  raw_body jsonb not null,
  headers jsonb,
  constraint webhook_events_body_size check (octet_length(raw_body::text) <= 262144)
);

create index if not exists idx_webhook_events_source_ext
  on public.webhook_events(source, external_id);
create index if not exists idx_webhook_events_unprocessed
  on public.webhook_events(received_at desc)
  where processed_at is null;
create unique index if not exists uq_webhook_events_source_external
  on public.webhook_events(source, external_id)
  where external_id is not null;

alter table public.webhook_events enable row level security;

-- ============================================================
-- CALL_METRICS
-- ============================================================
create table if not exists public.call_metrics (
  call_id uuid primary key references public.calls(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tts_first_byte_ms int,
  el_ws_open_ms int,
  call_duration_seconds int,
  transcript_turn_count int,
  tool_call_count int,
  created_at timestamptz default now()
);

create index if not exists idx_call_metrics_tenant_created
  on public.call_metrics(tenant_id, created_at desc);

alter table public.call_metrics enable row level security;

create policy "call_metrics_select" on public.call_metrics
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ============================================================
-- STORAGE BUCKET — call-recordings (private, 50 MB, audio/mpeg|mp4)
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'call-recordings',
  'call-recordings',
  false,
  52428800,
  array['audio/mpeg', 'audio/mp4']
)
on conflict (id) do nothing;

commit;
