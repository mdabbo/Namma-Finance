-- Read-only check before applying supabase-0021-time-entry-capture.sql.
-- Safe to run in the Supabase SQL Editor: it does not change any data or DDL.
-- "ready" must be true. Counts only -- no emails, names or amounts.

select jsonb_build_object(
  'user_roles_table', to_regclass('public.user_roles') is not null,
  'time_entries_table', to_regclass('public.time_entries') is not null,
  'admin_function', to_regprocedure('public.nf_is_admin()') is not null,
  'finance_role_function', to_regprocedure('public.nf_can_manage_finance()') is not null,
  'time_entries_lww_trigger', exists(
    select 1 from pg_trigger
    where tgrelid = to_regclass('public.time_entries') and tgname = 'trg_time_entries_lww' and not tgisinternal
  ),
  'time_entries_open_office_all', exists(
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'time_entries' and policyname = 'office_all'
  ),
  'time_entries_policies', (
    select coalesce(jsonb_agg(policyname order by policyname), '[]'::jsonb)
    from pg_policies where schemaname = 'public' and tablename = 'time_entries'
  ),
  -- true once 0021 has been applied
  'person_link_column', exists(
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_roles' and column_name = 'person_id'
  ),
  'capture_guard_trigger', exists(
    select 1 from pg_trigger
    where tgrelid = to_regclass('public.time_entries') and tgname = 'trg_time_entries_capture_guard' and not tgisinternal
  ),
  'ready',
    to_regclass('public.user_roles') is not null
    and to_regclass('public.time_entries') is not null
    and to_regprocedure('public.nf_is_admin()') is not null
    and to_regprocedure('public.nf_can_manage_finance()') is not null
    and not exists(
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'time_entries' and policyname = 'office_all'
    )
) as dabworks_0021_preflight;
