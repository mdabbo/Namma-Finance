-- NAMAA Finance — Phase 3 sync backend schema (Supabase / Postgres).
-- Run this ONCE in the Supabase SQL editor of your project (see PHASE3-SETUP.md).
--
-- Mirrors the desktop SQLite schema keyed by the rows' sync_uuid:
--  * uuid        — primary key, matches the local sync_uuid
--  * updated_at  — last modification (device clock, ISO); drives sync cursors
--  * deleted_at  — soft delete; devices pull it and delete locally
--  * a BEFORE UPDATE guard rejects writes older than the stored row, so
--    concurrent devices can upsert blindly and last-writer-wins holds
--    server-side.
-- Money: *_minor bigint (integer minor units). Rates: *_bp int. FX: micro-units.
-- Derived figures are never stored — same rule as the app.

create or replace function nf_lww_guard() returns trigger
language plpgsql as $$
begin
  if new.updated_at <= old.updated_at then
    return null; -- older or same write loses; silently keep the stored row
  end if;
  return new;
end $$;

-- ─── parents ───────────────────────────────────────────────────────────────

create table clients (
  uuid uuid primary key,
  name text not null,
  company text,
  address text,
  phone text,
  email text,
  tax_number text,
  contacts text,
  notes text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table people (
  uuid uuid primary key,
  type text not null default 'FREELANCER',
  name text not null,
  specialization text,
  phone text,
  email text,
  bank_account text,
  hourly_rate_minor bigint,
  monthly_rate_minor bigint,
  currency text not null default 'EGP',
  notes text,
  is_active int not null default 1,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table expense_categories (
  uuid uuid primary key,
  name_en text not null,
  name_ar text not null,
  is_active int not null default 1,
  sort_order int not null default 0,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table projects (
  uuid uuid primary key,
  code text not null,
  name text not null,
  client_id uuid not null references clients(uuid) on delete cascade,
  country text,
  city text,
  manager text,
  discipline text not null default 'MULTI',
  project_type text,
  status text not null default 'ACTIVE',
  currency text not null default 'EGP',
  fx_rate_micro bigint not null default 1000000,
  start_date text,
  end_date text,
  progress_bp int not null default 0,
  description text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

-- ─── project tree ──────────────────────────────────────────────────────────

create table contracts (
  uuid uuid primary key,
  project_id uuid not null references projects(uuid) on delete cascade,
  number text not null,
  title text,
  value_minor bigint not null default 0,
  vat_bp int not null default 1400,
  retention_bp int not null default 0,
  withholding_bp int not null default 0,
  advance_minor bigint not null default 0,
  advance_recovery_method text not null default 'PROPORTIONAL',
  performance_bond_bp int not null default 0,
  performance_bond_bank text,
  performance_bond_expiry text,
  payment_terms_days int not null default 30,
  payment_terms_notes text,
  valuation_mode text not null default 'LUMP_SUM',
  -- JSON as in the app; certificateId/stageId inside are sync uuids remotely
  milestones text,
  drawings text,
  attachments text,
  signed_date text,
  notes text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table project_stages (
  uuid uuid primary key,
  project_id uuid not null references projects(uuid) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  start_date text,
  end_date text,
  status text not null default 'PLANNED',
  completion_bp int not null default 0,
  engineers text,
  notes text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table documents (
  uuid uuid primary key,
  project_id uuid not null references projects(uuid) on delete cascade,
  category text not null default 'OTHER',
  title text not null,
  path text not null,
  added_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table project_assignments (
  uuid uuid primary key,
  person_id uuid not null references people(uuid) on delete cascade,
  project_id uuid not null references projects(uuid) on delete cascade,
  agreed_minor bigint not null default 0,
  currency text not null default 'EGP',
  fx_rate_micro bigint not null default 1000000,
  scope text,
  progress_note text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table payment_certificates (
  uuid uuid primary key,
  contract_id uuid not null references contracts(uuid) on delete cascade,
  seq int not null,
  number text not null,
  date text not null,
  submission_date text,
  due_date_override text,
  description text,
  gross_minor bigint not null default 0,
  discount_minor bigint not null default 0,
  manual_advance_recovery_minor bigint,
  status text not null default 'DRAFT',
  -- the app's own soft delete (trash), distinct from the sync soft delete
  app_deleted_at text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table payments (
  uuid uuid primary key,
  contract_id uuid not null references contracts(uuid) on delete cascade,
  kind text not null default 'CERTIFICATE',
  number text not null,
  date text not null,
  amount_minor bigint not null,
  method text not null default 'BANK_TRANSFER',
  bank text,
  reference text,
  notes text,
  app_deleted_at text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table payment_certificate_allocations (
  uuid uuid primary key,
  payment_id uuid not null references payments(uuid) on delete cascade,
  certificate_id uuid not null references payment_certificates(uuid) on delete cascade,
  amount_minor bigint not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table person_payments (
  uuid uuid primary key,
  assignment_id uuid not null references project_assignments(uuid) on delete cascade,
  date text not null,
  amount_minor bigint not null,
  note text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table expenses (
  uuid uuid primary key,
  date text not null,
  category_id uuid not null references expense_categories(uuid) on delete restrict,
  description text not null,
  project_id uuid references projects(uuid) on delete cascade,
  supplier text,
  amount_minor bigint not null,
  currency text not null default 'EGP',
  fx_rate_micro bigint not null default 1000000,
  attachment_path text,
  person_payment_id uuid references person_payments(uuid) on delete cascade,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table recurring_expenses (
  uuid uuid primary key,
  name text not null,
  category_id uuid not null references expense_categories(uuid) on delete restrict,
  amount_minor bigint not null,
  currency text not null default 'EGP',
  fx_rate_micro bigint not null default 1000000,
  day_of_month int not null default 1,
  is_active int not null default 1,
  notes text,
  created_at text,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table time_entries (
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

-- ─── cursors, guard, security ──────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'clients','people','expense_categories','projects','contracts',
    'project_stages','documents','time_entries','project_assignments','payment_certificates',
    'payments','payment_certificate_allocations','person_payments',
    'expenses','recurring_expenses'
  ] loop
    execute format('create index idx_%s_updated on %I (updated_at)', t, t);
    execute format('create trigger trg_%s_lww before update on %I for each row execute function nf_lww_guard()', t, t);
    execute format('alter table %I enable row level security', t);
    -- one office, one account: any signed-in user has full access (roles come in Phase 5)
    execute format('create policy office_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
