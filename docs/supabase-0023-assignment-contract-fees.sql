-- Apply after supabase-0022-assignment-lifecycle.sql.
-- Schema 31 and later: optional fee per contract on a team assignment
-- (desktop migration 0009).
--
-- WHY THIS EXISTS: desktop migration 0009 added project_assignments.contract_fees
-- and the sync registry pushes it. Without this column every push of
-- project_assignments fails with
--     Could not find the 'contract_fees' column of 'project_assignments'
--     in the schema cache
-- and nothing after that table in the sync order is exchanged either.
--
-- contract_fees is JSON text {"<contract number>": <fee in minor units>}, or
-- NULL for the original single-fee behaviour. It stays text, exactly as the
-- desktop stores it, so a value pushed and pulled back is byte-for-byte the one
-- that was written. The desktop validates the JSON itself (json_valid CHECK).
--
-- It only ADDS a nullable column; existing rows stay NULL, which is what they
-- were. Safe to re-run.

DO $$
BEGIN
  IF to_regclass('public.project_assignments') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: public.project_assignments does not exist (apply supabase-schema.sql first)';
  END IF;
END $$;

ALTER TABLE public.project_assignments ADD COLUMN IF NOT EXISTS contract_fees text;

NOTIFY pgrst, 'reload schema';
