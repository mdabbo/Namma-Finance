-- Apply before syncing desktop schema 9.
create table if not exists contract_revisions (
  uuid uuid primary key, contract_id uuid not null, revision_number integer not null,
  effective_date date not null, contract_value_minor bigint not null, vat_bp integer not null,
  retention_bp integer not null, withholding_bp integer not null, advance_minor bigint not null,
  advance_recovery_method text not null, payment_terms_days integer not null, currency text not null,
  fx_rate_micro bigint not null, reason text not null, created_at timestamptz not null,
  created_by text, approved_at timestamptz, updated_at timestamptz not null, deleted_at timestamptz,
  unique(contract_id, revision_number)
);
create table if not exists variation_orders (
  uuid uuid primary key, contract_id uuid not null, revision_id uuid not null, number text not null,
  description text, value_delta_minor bigint not null, approved_at timestamptz, created_at timestamptz not null,
  created_by text, updated_at timestamptz not null, deleted_at timestamptz,
  unique(contract_id, number)
);
alter table payment_certificates add column if not exists contract_revision_id uuid;
alter table payment_certificates add column if not exists contract_value_minor_snapshot bigint;
alter table payment_certificates add column if not exists vat_bp_snapshot integer;
alter table payment_certificates add column if not exists retention_bp_snapshot integer;
alter table payment_certificates add column if not exists withholding_bp_snapshot integer;
alter table payment_certificates add column if not exists advance_minor_snapshot bigint;
alter table payment_certificates add column if not exists advance_method_snapshot text;
alter table payment_certificates add column if not exists payment_terms_days_snapshot integer;
alter table payment_certificates add column if not exists currency_snapshot text;
alter table payment_certificates add column if not exists fx_rate_micro_snapshot bigint;
