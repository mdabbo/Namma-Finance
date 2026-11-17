import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Shared set-up for the tests that run the real docs/supabase-*.sql scripts in
 * an embedded Postgres: where the scripts are, the few Supabase-provided
 * pieces that have to be stubbed, and the order the scripts are applied in.
 */

export const docs = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), "utf8");

export const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
$$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`;

/** docs/PHASE3-SETUP.md apply order (repair-only and optional scripts omitted). */
export const APPLY_ORDER = [
  "supabase-schema.sql",
  "supabase-roles.sql",
  "supabase-0007-time-entries.sql",
  "supabase-0008-financial-lifecycle.sql",
  "supabase-0009-contract-revisions.sql",
  "supabase-0010-contract-revision-integrity.sql",
  "supabase-0011-payment-allocation-integrity.sql",
  "supabase-security-hardening.sql",
  "supabase-0012-domain-validation.sql",
  "supabase-0013-managed-documents.sql",
  "supabase-0014-numbering-safety.sql",
  "supabase-0015-contract-sync-security.sql",
  "supabase-0019-special-person-payments.sql",
  "supabase-0020-stage-progress-log.sql",
];
