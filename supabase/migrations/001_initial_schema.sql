-- 001_initial_schema.sql
-- Voice Agent Marketing SaaS — Full initial schema

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ============================================================
-- TENANTS
-- ============================================================
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  business_type text not null default 'general',
  plan text not null default 'basic',
  calls_used_this_month integer not null default 0,
  calls_limit integer not null default 300,
  voicenter_credentials text, -- encrypted via application-level envelope encryption
  whatsapp_credentials text,  -- encrypted via application-level envelope encryption
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenants enable row level security;

create policy "tenants_select" on public.tenants
  for select using (id = (auth.jwt() ->> 'tenant_id')::uuid);

create policy "tenants_update" on public.tenants
  for update using (id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ============================================================
-- USERS
-- ============================================================
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  role text not null default 'owner' check (role in ('owner', 'admin', 'viewer')),
  created_at timestamptz not null default now()
);

alter table public.users enable row level security;

create policy "users_select" on public.users
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

create policy "users_insert_owner" on public.users
  for insert with check (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') = 'owner'
  );

create policy "users_update_owner" on public.users
  for update using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') = 'owner'
  );

-- ============================================================
-- CAMPAIGNS
-- ============================================================
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed')),
  template_id uuid, -- FK added after templates table
  script text not null default '',
  questions jsonb not null default '[]'::jsonb,
  whatsapp_followup_template text,
  whatsapp_followup_link text,
  schedule_days text[] not null default '{sun,mon,tue,wed,thu}',
  schedule_windows jsonb not null default '[{"start":"10:00","end":"13:00"},{"start":"16:00","end":"19:00"}]'::jsonb,
  max_concurrent_calls integer not null default 5,
  max_retry_attempts integer not null default 2,
  retry_delay_minutes integer not null default 120,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.campaigns enable row level security;

create policy "campaigns_select" on public.campaigns
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

create policy "campaigns_insert" on public.campaigns
  for insert with check (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

create policy "campaigns_update" on public.campaigns
  for update using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

create policy "campaigns_delete" on public.campaigns
  for delete using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') = 'owner'
  );

-- ============================================================
-- CONTACTS (tenant-scoped, campaign-independent)
-- ============================================================
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone text not null,
  name text,
  email text,
  custom_fields jsonb not null default '{}'::jsonb,
  is_dnc boolean not null default false,
  dnc_at timestamptz,
  dnc_source text check (dnc_source in ('manual', 'opt_out', 'national_registry')),
  created_at timestamptz not null default now(),
  constraint contacts_tenant_phone_unique unique (tenant_id, phone)
);

create index idx_contacts_tenant_dnc on public.contacts(tenant_id, is_dnc);

alter table public.contacts enable row level security;

create policy "contacts_select" on public.contacts
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

create policy "contacts_insert" on public.contacts
  for insert with check (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

create policy "contacts_update" on public.contacts
  for update using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

-- ============================================================
-- CAMPAIGN_CONTACTS (join table)
-- ============================================================
create table public.campaign_contacts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'queued', 'calling', 'completed', 'failed', 'no_answer', 'dnc')),
  attempt_count integer not null default 0,
  next_retry_at timestamptz,
  call_id uuid, -- FK added after calls table
  created_at timestamptz not null default now(),
  constraint campaign_contacts_unique unique (tenant_id, contact_id, campaign_id)
);

create index idx_campaign_contacts_status on public.campaign_contacts(campaign_id, status);

alter table public.campaign_contacts enable row level security;

create policy "campaign_contacts_select" on public.campaign_contacts
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

create policy "campaign_contacts_insert" on public.campaign_contacts
  for insert with check (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

create policy "campaign_contacts_update" on public.campaign_contacts
  for update using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

-- ============================================================
-- CALLS
-- ============================================================
create table public.calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  campaign_contact_id uuid not null references public.campaign_contacts(id) on delete cascade,
  voicenter_call_id text,
  status text not null default 'initiated' check (status in ('initiated', 'ringing', 'connected', 'completed', 'failed', 'no_answer', 'dead_letter')),
  failure_reason text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  recording_path text,
  lead_score integer check (lead_score between 1 and 5),
  lead_status text check (lead_status in ('hot', 'warm', 'cold', 'not_interested', 'callback')),
  qualification_answers jsonb,
  whatsapp_sent boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_calls_tenant_campaign on public.calls(tenant_id, campaign_id, created_at);
create index idx_calls_voicenter on public.calls(voicenter_call_id);
create index idx_calls_lead_status on public.calls(tenant_id, lead_status);

alter table public.calls enable row level security;

create policy "calls_select" on public.calls
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- Add FK from campaign_contacts to calls
alter table public.campaign_contacts
  add constraint campaign_contacts_call_fk
  foreign key (call_id) references public.calls(id) on delete set null;

-- ============================================================
-- CALL_TRANSCRIPTS
-- ============================================================
create table public.call_transcripts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null unique references public.calls(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transcript jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.call_transcripts enable row level security;

create policy "call_transcripts_select" on public.call_transcripts
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ============================================================
-- TEMPLATES
-- ============================================================
create table public.templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  name text not null,
  business_type text not null default 'general',
  script text not null default '',
  questions jsonb not null default '[]'::jsonb,
  whatsapp_template text,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

-- Add FK from campaigns to templates
alter table public.campaigns
  add constraint campaigns_template_fk
  foreign key (template_id) references public.templates(id) on delete set null;

alter table public.templates enable row level security;

-- System templates readable by all authenticated users
create policy "templates_select_system" on public.templates
  for select using (is_system = true);

-- Tenant templates readable by tenant members
create policy "templates_select_tenant" on public.templates
  for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

create policy "templates_insert" on public.templates
  for insert with check (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

create policy "templates_update" on public.templates
  for update using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

-- ============================================================
-- AUDIT_LOG (immutable)
-- ============================================================
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);

create index idx_audit_log_tenant on public.audit_log(tenant_id, action, created_at);

alter table public.audit_log enable row level security;

-- Only owner/admin can read audit logs
create policy "audit_log_select" on public.audit_log
  for select using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner', 'admin')
  );

-- Insert only — no updates or deletes
create policy "audit_log_insert" on public.audit_log
  for insert with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- Explicitly deny update and delete (RLS default denies, but be explicit)
-- No UPDATE or DELETE policies = denied by default with RLS enabled.

-- ============================================================
-- SEED: System templates
-- ============================================================
insert into public.templates (name, business_type, script, questions, whatsapp_template, is_system) values
(
  'נדל"ן',
  'real_estate',
  'אתה נציג/ת מכירות של [שם העסק]. התקשר/י ללקוח ובדוק/י התעניינות בנכסים. שאל/י את שאלות ההסמכה בזו אחר זו. אל תמציא מחירים או נכסים. אם הלקוח מעוניין, תגיד/י שתשלח/י פרטים בוואטסאפ.',
  '[{"question": "מה התקציב שלך?", "key": "budget"}, {"question": "באיזה אזור אתה מחפש?", "key": "area"}, {"question": "כמה חדרים?", "key": "rooms"}, {"question": "מה לוח הזמנים שלך?", "key": "timeline", "options": ["מיידי", "תוך 3 חודשים", "תוך 6 חודשים", "רק מתעניין"]}]',
  'הנה הנכסים שמתאימים לך: [link]',
  true
),
(
  'ביטוח',
  'insurance',
  'אתה נציג/ת של [שם העסק]. התקשר/י ללקוח ובדוק/י את מצב הביטוח שלו. שאל/י את שאלות ההסמכה בזו אחר זו. אל תמציא הצעות מחיר. אם הלקוח מעוניין, תגיד/י שתשלח/י הצעה בוואטסאפ.',
  '[{"question": "מי חברת הביטוח הנוכחית שלך?", "key": "current_provider"}, {"question": "מתי מסתיימת הפוליסה?", "key": "renewal_date"}, {"question": "מה אתה מבטח?", "key": "insuring"}, {"question": "כמה אתה מרוצה מהשירות הנוכחי?", "key": "satisfaction", "options": ["מאוד מרוצה", "בסדר", "לא מרוצה"]}]',
  'הנה הצעת מחיר מותאמת אישית: [link]',
  true
),
(
  'שירותי בית',
  'services',
  'אתה נציג/ת של [שם העסק]. התקשר/י ללקוח שהשאיר פרטים. שאל/י את שאלות ההסמכה בזו אחר זו. אל תמציא מחירים. אם הלקוח מעוניין, תגיד/י שתשלח/י הצעה בוואטסאפ.',
  '[{"question": "איזה סוג שירות מעניין אותך?", "key": "service_type"}, {"question": "מה גודל הנכס?", "key": "property_size"}, {"question": "מתי נוח לך?", "key": "preferred_dates"}, {"question": "מה התקציב שלך?", "key": "budget"}, {"question": "כמה דחוף?", "key": "urgency", "options": ["דחוף מאוד", "תוך חודש", "רק בודק"]}]',
  'הנה הצעת המחיר שלנו + קישור לקביעת מועד: [link]',
  true
);

-- ============================================================
-- FUNCTION: Atomic call counter increment
-- ============================================================
create or replace function public.increment_calls_used(p_tenant_id uuid)
returns integer
language sql
as $$
  update public.tenants
  set calls_used_this_month = calls_used_this_month + 1,
      updated_at = now()
  where id = p_tenant_id
  returning calls_used_this_month;
$$;

-- ============================================================
-- FUNCTION: Monthly usage reset (called by cron/scheduled job)
-- ============================================================
create or replace function public.reset_monthly_usage()
returns void
language sql
as $$
  update public.tenants
  set calls_used_this_month = 0,
      updated_at = now();
$$;
