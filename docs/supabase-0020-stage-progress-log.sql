-- Apply after supabase-0019-special-person-payments.sql.
-- Schema 30: append-only stage progress history (desktop migration 0008).
--
-- Desktop builds on schema 30 pull and push this table. Until this script has
-- run, their sync stops with "pull stage_progress_log: ..." and nothing else
-- is exchanged -- apply it BEFORE the first sync from a schema 30 build.
-- Older desktop builds and the mobile app ignore the table.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.stage_progress_log (
  uuid uuid PRIMARY KEY,
  -- The stage is plain data, not a foreign key: a deleted stage keeps its
  -- history, and a cascade must never remove evidence.
  stage_uuid uuid NOT NULL,
  completion_bp int NOT NULL CHECK (completion_bp BETWEEN 0 AND 10000),
  recorded_at text NOT NULL,
  source text NOT NULL CHECK (length(source) > 0),
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_stage_progress_log_updated ON public.stage_progress_log (updated_at);
CREATE INDEX IF NOT EXISTS idx_stage_progress_log_stage ON public.stage_progress_log (stage_uuid, recorded_at);

-- Append-only, as on the desktop. A re-push of an identical row is allowed
-- through (the LWW guard then keeps the stored row); any change to what was
-- recorded, a soft delete, or a hard delete is refused.
CREATE OR REPLACE FUNCTION public.nf_stage_progress_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'STAGE_PROGRESS_LOG_IMMUTABLE';
  END IF;
  IF NEW.uuid IS DISTINCT FROM OLD.uuid
     OR NEW.stage_uuid IS DISTINCT FROM OLD.stage_uuid
     OR NEW.completion_bp IS DISTINCT FROM OLD.completion_bp
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'STAGE_PROGRESS_LOG_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

-- BEFORE triggers fire in name order: "immutable" runs before "lww".
DROP TRIGGER IF EXISTS trg_stage_progress_log_immutable ON public.stage_progress_log;
CREATE TRIGGER trg_stage_progress_log_immutable
  BEFORE UPDATE OR DELETE ON public.stage_progress_log
  FOR EACH ROW EXECUTE FUNCTION public.nf_stage_progress_log_immutable();

DROP TRIGGER IF EXISTS trg_stage_progress_log_lww ON public.stage_progress_log;
CREATE TRIGGER trg_stage_progress_log_lww
  BEFORE UPDATE ON public.stage_progress_log
  FOR EACH ROW EXECUTE FUNCTION nf_lww_guard();

ALTER TABLE public.stage_progress_log ENABLE ROW LEVEL SECURITY;

-- Same access as project_stages, whichever policy model this project runs:
-- with supabase-security-hardening.sql applied, members read and engineers
-- and above write; without it, any signed-in user has full access.
DO $$
BEGIN
  DROP POLICY IF EXISTS office_all ON public.stage_progress_log;
  DROP POLICY IF EXISTS namaa_member_read ON public.stage_progress_log;
  DROP POLICY IF EXISTS namaa_member_write ON public.stage_progress_log;
  IF to_regprocedure('public.nf_can_engineer_write()') IS NOT NULL
     AND to_regprocedure('public.nf_is_member()') IS NOT NULL THEN
    CREATE POLICY namaa_member_read ON public.stage_progress_log
      FOR SELECT TO authenticated USING (nf_is_member());
    CREATE POLICY namaa_member_write ON public.stage_progress_log
      FOR ALL TO authenticated USING (nf_can_engineer_write()) WITH CHECK (nf_can_engineer_write());
  ELSE
    CREATE POLICY office_all ON public.stage_progress_log
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.stage_progress_log TO authenticated;

NOTIFY pgrst, 'reload schema';
