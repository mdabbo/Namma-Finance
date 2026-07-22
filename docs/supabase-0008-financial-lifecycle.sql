-- Apply to an existing NAMAA Finance Supabase database before enabling sync
-- from a desktop running local schema version 8.
alter table clients add column if not exists archived_at timestamptz, add column if not exists archived_by text, add column if not exists archive_reason text;
alter table projects add column if not exists archived_at timestamptz, add column if not exists archived_by text, add column if not exists archive_reason text;
alter table contracts add column if not exists archived_at timestamptz, add column if not exists archived_by text, add column if not exists archive_reason text;
alter table people add column if not exists archived_at timestamptz, add column if not exists archived_by text, add column if not exists archive_reason text;
alter table project_assignments add column if not exists archived_at timestamptz, add column if not exists archived_by text, add column if not exists archive_reason text;
alter table payment_certificates add column if not exists archived_at timestamptz, add column if not exists archived_by text, add column if not exists archive_reason text, add column if not exists voided_at timestamptz, add column if not exists voided_by text, add column if not exists void_reason text, add column if not exists reversal_of_id bigint;
alter table payments add column if not exists voided_at timestamptz, add column if not exists voided_by text, add column if not exists void_reason text, add column if not exists reversal_of_id bigint;
alter table person_payments add column if not exists voided_at timestamptz, add column if not exists voided_by text, add column if not exists void_reason text, add column if not exists reversal_of_id bigint;
alter table expenses add column if not exists archived_at timestamptz, add column if not exists archived_by text, add column if not exists archive_reason text, add column if not exists voided_at timestamptz, add column if not exists voided_by text, add column if not exists void_reason text, add column if not exists reversal_of_id bigint;
