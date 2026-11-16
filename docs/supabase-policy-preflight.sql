-- Read-only DABWORKS Finance cloud-policy inspection (plan step F0.1).
-- Safe to run in the Supabase SQL Editor: it does not change any data or DDL.
--
-- Answers one question before any phone is allowed to write: which row-level
-- security policies are actually live? It reports policy definitions and
-- role COUNTS only -- no emails, names, amounts or keys.
--
-- Run it, then copy the single JSON cell of the result.

select jsonb_build_object(

  -- The role helper functions from supabase-roles.sql / supabase-security-hardening.sql.
  'functions', jsonb_build_object(
    'nf_is_admin',            to_regprocedure('public.nf_is_admin()') is not null,
    'nf_is_member',           to_regprocedure('public.nf_is_member()') is not null,
    'nf_can_manage_finance',  to_regprocedure('public.nf_can_manage_finance()') is not null,
    'nf_can_engineer_write',  to_regprocedure('public.nf_can_engineer_write()') is not null
  ),

  -- How many logins hold each role. One shared office login shows as a single ADMIN.
  'role_counts', case
    when to_regclass('public.user_roles') is null then null
    else (
      select coalesce(jsonb_object_agg(x.role, x.n), '{}'::jsonb)
      from (
        select (to_jsonb(ur) ->> 'role') as role, count(*) as n
        from public.user_roles ur
        group by 1
      ) x
    )
  end,

  -- Tables any signed-in login can still write freely (the pre-hardening policy).
  'tables_with_open_office_all', (
    select coalesce(jsonb_agg(p.tablename order by p.tablename), '[]'::jsonb)
    from pg_policies p
    where p.schemaname = 'public' and p.policyname = 'office_all'
  ),

  -- Tables with row-level security switched off entirely.
  'tables_without_rls', (
    select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  ),

  -- Tables with RLS on but no policy at all (nobody but the service role can touch them).
  'tables_with_rls_and_no_policy', (
    select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname
      )
  ),

  -- Any existing link from a login to a people row (needed for "own entries only").
  'people_auth_link_columns', (
    select coalesce(jsonb_agg(col.column_name order by col.column_name), '[]'::jsonb)
    from information_schema.columns col
    where col.table_schema = 'public' and col.table_name = 'people'
      and col.column_name in ('auth_user_id', 'user_id', 'auth_uid')
  ),

  -- The link supabase-0021 adds: user_roles.person_id, and how many logins use it.
  'user_roles_person_link', exists(
    select 1 from information_schema.columns col
    where col.table_schema = 'public' and col.table_name = 'user_roles'
      and col.column_name = 'person_id'
  ),
  'logins_linked_to_a_person', case
    when to_regclass('public.user_roles') is null then null
    else (
      select count(*) from public.user_roles ur
      where (to_jsonb(ur) ->> 'person_id') is not null
    )
  end,

  -- Every policy on the app's tables, exactly as Postgres stores it.
  'public_policies', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', p.tablename,
      'policy', p.policyname,
      'cmd', p.cmd,
      'permissive', p.permissive,
      'roles', to_jsonb(p.roles),
      'using', p.qual,
      'with_check', p.with_check
    ) order by p.tablename, p.policyname), '[]'::jsonb)
    from pg_policies p
    where p.schemaname = 'public'
  ),

  -- Policies on file storage (the namaa-documents bucket).
  'storage_policies', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'policy', p.policyname,
      'cmd', p.cmd,
      'roles', to_jsonb(p.roles),
      'using', p.qual,
      'with_check', p.with_check
    ) order by p.policyname), '[]'::jsonb)
    from pg_policies p
    where p.schemaname = 'storage' and p.tablename = 'objects'
  )

) as dabworks_cloud_policies;
