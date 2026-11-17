-- Apply after supabase-0021-time-entry-capture.sql.
-- Schema 31: optional fee per contract on a team assignment (desktop migration 0009).
--
-- Desktop builds on schema 31 push project_assignments.contract_fees. Until this
-- script has run, their sync of assignments fails -- apply it BEFORE the first
-- sync from a schema 31 build. Older builds and the mobile app ignore the
-- column (mobile reads it when present, so payables follow the per-contract fee).
--
-- JSON text {"<contract number>": <fee minor units>}; NULL = one fee split by
-- value share (the original behaviour). Safe to re-run.

ALTER TABLE public.project_assignments
  ADD COLUMN IF NOT EXISTS contract_fees text
  CHECK (contract_fees IS NULL OR contract_fees::jsonb IS NOT NULL);

NOTIFY pgrst, 'reload schema';
