-- 004_inbound_calls.sql
-- Inbound DID routing support with scalable phone-number mapping.

-- 1) Multiple inbound numbers per tenant (future-proof vs single-column tenant mapping).
create table if not exists public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone_number text not null unique,
  default_campaign_id uuid references public.campaigns(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_phone_numbers_tenant_id on public.phone_numbers(tenant_id);

alter table public.phone_numbers enable row level security;

create policy "phone_numbers_select" on public.phone_numbers
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

create policy "phone_numbers_insert" on public.phone_numbers
  for insert with check (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

create policy "phone_numbers_update" on public.phone_numbers
  for update using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

create policy "phone_numbers_delete" on public.phone_numbers
  for delete using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') = 'owner'
  );

-- 2) Stable DB-driven fallback defaults (avoid brittle env UUID wiring).
alter table public.tenants
  add column if not exists is_system_default boolean not null default false;

alter table public.campaigns
  add column if not exists is_system_default boolean not null default false;

create unique index if not exists idx_tenants_system_default_true
  on public.tenants(is_system_default)
  where is_system_default = true;

create unique index if not exists idx_campaigns_system_default_true
  on public.campaigns(is_system_default)
  where is_system_default = true;

-- 3) Inbound/outbound call direction for analytics segmentation.
alter table public.calls
  add column if not exists direction text not null default 'outbound'
  check (direction in ('outbound', 'inbound'));

-- 4) Inbound calls can be created without outbound queue context.
alter table public.calls
  alter column campaign_contact_id drop not null;
