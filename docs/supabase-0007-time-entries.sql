-- ─────────────────────────────────────────────────────────────────────────
-- Supabase delta for v0.6.x — the time_entries table (time tracking).
--
-- Run this ONCE in your Supabase project's SQL Editor. It only ADDS the new
-- table; it does not touch any existing table. It reuses the nf_lww_guard()
-- function that the original supabase-schema.sql already created.
-- Safe to re-run: every statement uses "if not exists" / "or replace".
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists time_entries (
  uuid uuid primary key,
  person_id uuid not null references people(uuid) on delete cascade,
  project_id uuid not null references projects(uuid) on delete cascade,
  stage_id uuid references project_stages(uuid) on delete set null,
  date text not null,
  minutes int not null,
  billable int not null default 1,
  note text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists idx_time_entries_updated on time_entries (updated_at);

-- last-writer-wins guard (same function used by every other table)
drop trigger if exists trg_time_entries_lww on time_entries;
create trigger trg_time_entries_lww
  before update on time_entries
  for each row execute function nf_lww_guard();

-- row-level security: one office, any signed-in user has full access
alter table time_entries enable row level security;
drop policy if exists office_all on time_entries;
create policy office_all on time_entries
  for all to authenticated using (true) with check (true);
