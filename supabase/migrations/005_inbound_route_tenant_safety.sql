-- 005_inbound_route_tenant_safety.sql
-- Repair and enforce tenant-safe inbound DID default campaign routing.

-- Existing remote state may contain phone_numbers.default_campaign_id values
-- written before tenant-alignment enforcement existed. Prefer disabling only
-- invalid defaults over failing the migration.
update public.phone_numbers pn
set
  default_campaign_id = null,
  updated_at = now()
from public.campaigns c
where pn.default_campaign_id = c.id
  and pn.tenant_id <> c.tenant_id;

create or replace function public.enforce_phone_number_default_campaign_tenant()
returns trigger
language plpgsql
as $$
declare
  campaign_tenant_id uuid;
begin
  if new.default_campaign_id is null then
    return new;
  end if;

  select tenant_id
    into campaign_tenant_id
  from public.campaigns
  where id = new.default_campaign_id;

  if campaign_tenant_id is null then
    raise exception 'default_campaign_id % does not reference an existing campaign', new.default_campaign_id
      using errcode = '23503';
  end if;

  if campaign_tenant_id <> new.tenant_id then
    raise exception 'phone_numbers.default_campaign_id must belong to the same tenant'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_phone_numbers_default_campaign_tenant on public.phone_numbers;

create trigger trg_phone_numbers_default_campaign_tenant
before insert or update of tenant_id, default_campaign_id
on public.phone_numbers
for each row
execute function public.enforce_phone_number_default_campaign_tenant();

create or replace function public.prevent_campaign_tenant_change_when_inbound_routed()
returns trigger
language plpgsql
as $$
begin
  if old.tenant_id is distinct from new.tenant_id
    and exists (
      select 1
      from public.phone_numbers
      where default_campaign_id = old.id
    )
  then
    raise exception 'campaigns.tenant_id cannot change while used as an inbound phone number default'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_campaigns_tenant_immutable_for_inbound_routes on public.campaigns;

create trigger trg_campaigns_tenant_immutable_for_inbound_routes
before update of tenant_id
on public.campaigns
for each row
execute function public.prevent_campaign_tenant_change_when_inbound_routed();
