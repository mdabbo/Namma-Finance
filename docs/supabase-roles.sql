-- NAMAA Finance — Phase 5 roles. Run ONCE in the Supabase SQL editor
-- (AFTER supabase-schema.sql). Creates the user_roles table that maps your
-- auth users (Authentication → Users) to an app role.
--
--  ADMIN      — everything, including managing users
--  ACCOUNTANT — all financial screens; cannot manage users
--  ENGINEER   — projects, stages and documents only; no money screens
--
-- The FIRST signed-in user to open the app claims the ADMIN role
-- automatically (bootstrap below); after that, only admins can add or
-- change roles — from the app's Settings → Users panel.
--
-- v1 note: screen access is enforced by the app; the database itself still
-- grants full read/write to any authenticated office login. Tightening RLS
-- per role can be added later without schema changes.

create table user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'ENGINEER' check (role in ('ADMIN','ACCOUNTANT','ENGINEER')),
  updated_at timestamptz not null default now()
);

-- SECURITY DEFINER helpers: policies on user_roles cannot query user_roles
-- directly (infinite RLS recursion), so these run with owner rights.
create or replace function nf_is_admin() returns boolean
language sql security definer set search_path = public as
$$ select exists (select 1 from user_roles where user_id = auth.uid() and role = 'ADMIN') $$;

create or replace function nf_roles_empty() returns boolean
language sql security definer set search_path = public as
$$ select not exists (select 1 from user_roles) $$;

alter table user_roles enable row level security;

-- everyone can read their own role
create policy read_own_role on user_roles
  for select to authenticated using (auth.uid() = user_id);

-- the very first user bootstraps as ADMIN
create policy bootstrap_first_admin on user_roles
  for insert to authenticated
  with check (auth.uid() = user_id and role = 'ADMIN' and nf_roles_empty());

-- admins manage everything
create policy admin_manage on user_roles
  for all to authenticated using (nf_is_admin()) with check (nf_is_admin());
