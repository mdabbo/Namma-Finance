-- NAMAA Finance Milestone 10 security hardening.
-- Apply after supabase-schema.sql and supabase-roles.sql.
-- This deployment currently models one office per Supabase project. Every
-- authenticated account must have an explicit user_roles membership row.

create or replace function nf_is_member() returns boolean
language sql stable security definer set search_path = public
as $$ select exists(select 1 from user_roles where user_id=auth.uid()) $$;

create or replace function nf_can_manage_finance() returns boolean
language sql stable security definer set search_path = public
as $$ select exists(select 1 from user_roles where user_id=auth.uid() and role in ('ADMIN','ACCOUNTANT')) $$;

create or replace function nf_can_engineer_write() returns boolean
language sql stable security definer set search_path = public
as $$ select exists(select 1 from user_roles where user_id=auth.uid() and role in ('ADMIN','ACCOUNTANT','ENGINEER')) $$;

do $$
declare t text;
begin
  foreach t in array array[
    'clients','people','expense_categories','projects','contracts','project_stages',
    'documents','time_entries','project_assignments','payment_certificates','payments',
    'payment_certificate_allocations','person_payments','expenses','recurring_expenses'
  ] loop
    execute format('drop policy if exists office_all on %I',t);
    execute format('drop policy if exists namaa_member_read on %I',t);
    execute format('drop policy if exists namaa_member_write on %I',t);
    execute format('drop policy if exists namaa_finance_write on %I',t);
    execute format('create policy namaa_member_read on %I for select to authenticated using (nf_is_member())',t);
  end loop;

  foreach t in array array[
    'project_stages','documents'
  ] loop
    execute format('create policy namaa_member_write on %I for all to authenticated using (nf_can_engineer_write()) with check (nf_can_engineer_write())',t);
  end loop;

  foreach t in array array[
    'clients','people','expense_categories','projects','time_entries','project_assignments',
    'contracts','payment_certificates','payments','payment_certificate_allocations',
    'person_payments','expenses','recurring_expenses'
  ] loop
    execute format('create policy namaa_finance_write on %I for all to authenticated using (nf_can_manage_finance()) with check (nf_can_manage_finance())',t);
  end loop;
end $$;

-- Do not trust role claims supplied by clients. user_roles remains protected
-- by its own policies and nf_is_admin() SECURITY DEFINER checks.
