-- Apply after supabase-0018-sync-peers.sql.
-- Adds the schema 29 marker for deliberate special team-member payments.

ALTER TABLE public.person_payments
  ADD COLUMN IF NOT EXISTS payment_kind text NOT NULL DEFAULT 'EARNED'
  CHECK (payment_kind IN ('EARNED','SPECIAL'));

NOTIFY pgrst, 'reload schema';
