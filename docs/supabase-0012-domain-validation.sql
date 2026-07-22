-- Milestone 11 sync delta. Apply after supabase-security-hardening.sql.
-- The timestamp is evidence that an exceptional due date was explicitly
-- confirmed; it contains no financial amount and is safe to synchronize.
alter table payment_certificates add column if not exists due_date_confirmed_at text;
