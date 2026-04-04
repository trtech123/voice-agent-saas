-- 002_auth_trigger.sql
-- Auto-create tenant + public.users row when a new auth user signs up.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  new_tenant_id uuid;
begin
  -- Create tenant from signup metadata
  insert into public.tenants (name, email, phone)
  values (
    coalesce(new.raw_user_meta_data ->> 'business_name', 'עסק חדש'),
    new.email,
    new.raw_user_meta_data ->> 'phone'
  )
  returning id into new_tenant_id;

  -- Create public.users row linked to auth user + tenant
  insert into public.users (id, tenant_id, email, role)
  values (new.id, new_tenant_id, new.email, 'owner');

  -- Store tenant_id in auth user metadata for RLS access
  update auth.users
  set raw_app_meta_data = raw_app_meta_data || jsonb_build_object(
    'tenant_id', new_tenant_id::text,
    'role', 'owner'
  )
  where id = new.id;

  return new;
end;
$$;

-- Trigger on auth.users insert
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
