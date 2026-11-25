-- Apply after supabase-0023-assignment-contract-fees.sql (any time after
-- supabase-security-hardening.sql and supabase-roles.sql).
--
-- WHY THIS EXISTS: the desktop keeps its exchange rates (the Central Bank of
-- Egypt buy rates it fetches, or the ones typed by hand) in its own local
-- database, and nothing synced them, so the phone could only use a rate typed
-- on the phone. This table is where the desktop PUBLISHES its rates at the end
-- of each sync, so the phone shows the same figures as the desktop.
--
-- One row per currency: EGP per one major unit x 1,000,000 (the desktop's own
-- unit, fx_rate_micro). EGP itself is not stored; it is always 1.
--
--  * READ : any login with a role (the phone reads it).
--  * WRITE: ADMIN and ACCOUNTANT only (the desktop's login). An engineer login
--           cannot change a rate, and the phone never writes this table.
--  * updated_at is the moment the desktop last changed that rate, and the
--    existing last-writer-wins guard keeps an older value from replacing a
--    newer one if two PCs publish.
--
-- It only ADDS a table. Nothing existing is read, changed or removed. If it is
-- not applied, the desktop's sync is unaffected (publishing rates is best
-- effort and reports its own error) and the phone keeps its typed rates.
--
-- Safe to re-run.

DO $$
BEGIN
  IF to_regprocedure('public.nf_lww_guard()') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: nf_lww_guard() does not exist (apply supabase-schema.sql first)';
  END IF;
  IF to_regprocedure('public.nf_is_member()') IS NULL OR to_regprocedure('public.nf_can_manage_finance()') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE_MISSING: role helpers do not exist (apply supabase-security-hardening.sql first)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fx_rates (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$' AND code <> 'EGP'),
  fx_rate_micro bigint NOT NULL CHECK (fx_rate_micro > 0),
  updated_at timestamptz NOT NULL
);

DROP TRIGGER IF EXISTS trg_fx_rates_lww ON public.fx_rates;
CREATE TRIGGER trg_fx_rates_lww
  BEFORE UPDATE ON public.fx_rates
  FOR EACH ROW EXECUTE FUNCTION public.nf_lww_guard();

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS namaa_member_read ON public.fx_rates;
CREATE POLICY namaa_member_read ON public.fx_rates
  FOR SELECT TO authenticated USING (public.nf_is_member());
DROP POLICY IF EXISTS namaa_finance_write ON public.fx_rates;
CREATE POLICY namaa_finance_write ON public.fx_rates
  FOR ALL TO authenticated
  USING (public.nf_can_manage_finance()) WITH CHECK (public.nf_can_manage_finance());

-- Make the new table visible to the API straight away.
NOTIFY pgrst, 'reload schema';
