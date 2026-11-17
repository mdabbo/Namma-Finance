-- Apply after supabase-0021-time-entry-capture.sql (any time after 0008).
-- Schema 25 and later: assignment lifecycle (desktop migration 0003).
--
-- WHY THIS EXISTS: desktop migration 0003 added five columns to
-- project_assignments and the sync registry has pushed them ever since, but no
-- cloud script created them. Every push of project_assignments therefore
-- fails with
--     Could not find the 'cancellation_reason' column of 'project_assignments'
--     in the schema cache
-- and, because the push stops at the first failing table, nothing after it in
-- the sync order (person_payments, expenses, recurring_expenses) is exchanged
-- either. The phone and other PCs stop seeing new data until this is applied.
--
-- It only ADDS columns and checks; it never rewrites or removes a row. Existing
-- assignments become ACTIVE, which is what they were. The desktop validates
-- every lifecycle change itself (CANCELLED_ASSIGNMENT_REQUIRES_EVIDENCE, ...);
-- the checks here refuse the same impossible rows from any other client.
--
-- Dates stay text, exactly as the desktop stores them, so a value pushed and
-- pulled back is byte-for-byte the one that was written.
--
-- Safe to re-run.

DO $$
BEGIN
  IF to_regclass('public.project_assignments') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: public.project_assignments does not exist (apply supabase-schema.sql first)';
  END IF;
END $$;

ALTER TABLE public.project_assignments
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS completed_at text,
  ADD COLUMN IF NOT EXISTS cancelled_at text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS earned_minor_at_cancellation bigint;

DO $$
BEGIN
  ALTER TABLE public.project_assignments DROP CONSTRAINT IF EXISTS project_assignments_lifecycle_status_check;
  ALTER TABLE public.project_assignments ADD CONSTRAINT project_assignments_lifecycle_status_check
    CHECK (lifecycle_status IN ('ACTIVE', 'COMPLETED', 'CANCELLED'));

  ALTER TABLE public.project_assignments DROP CONSTRAINT IF EXISTS project_assignments_cancellation_evidence_check;
  ALTER TABLE public.project_assignments ADD CONSTRAINT project_assignments_cancellation_evidence_check
    CHECK (lifecycle_status <> 'CANCELLED' OR (
      cancelled_at IS NOT NULL
      AND cancellation_reason IS NOT NULL AND btrim(cancellation_reason) <> ''
      AND earned_minor_at_cancellation IS NOT NULL));

  ALTER TABLE public.project_assignments DROP CONSTRAINT IF EXISTS project_assignments_completion_date_check;
  ALTER TABLE public.project_assignments ADD CONSTRAINT project_assignments_completion_date_check
    CHECK (lifecycle_status <> 'COMPLETED' OR completed_at IS NOT NULL);

  ALTER TABLE public.project_assignments DROP CONSTRAINT IF EXISTS project_assignments_earned_nonnegative_check;
  ALTER TABLE public.project_assignments ADD CONSTRAINT project_assignments_earned_nonnegative_check
    CHECK (earned_minor_at_cancellation IS NULL OR earned_minor_at_cancellation >= 0);
END $$;

-- Make the new columns visible to the API straight away; without this the
-- "schema cache" error can persist for a minute or two after the script runs.
NOTIFY pgrst, 'reload schema';
