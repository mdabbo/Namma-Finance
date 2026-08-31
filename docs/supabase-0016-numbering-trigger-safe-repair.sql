-- Forward-only repair for an existing cloud database where
-- supabase-0014-numbering-safety.sql rolled back because nf_lww_guard()
-- suppressed the legacy expenses.number backfill.
--
-- Resolve every duplicate reported by supabase-numbering-collision-preflight.sql
-- explicitly before running this migration. This migration never renames or
-- deletes business records automatically.

BEGIN;

-- Fail before changing the schema if a business number is still duplicated.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.projects GROUP BY code HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'DUPLICATE_PROJECT_CODE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts GROUP BY project_id, number HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'DUPLICATE_CONTRACT_NUMBER';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_certificates GROUP BY contract_id, number HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'DUPLICATE_CERTIFICATE_NUMBER';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments GROUP BY contract_id, number HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT_NUMBER';
  END IF;
END $$;

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS number text;

-- Schema backfills must preserve business timestamps. Temporarily disable only
-- the LWW guard: otherwise an UPDATE whose updated_at is unchanged is silently
-- discarded by that BEFORE UPDATE trigger.
ALTER TABLE public.expenses DISABLE TRIGGER trg_expenses_lww;
UPDATE public.expenses
SET number = 'EXP-'
  || COALESCE(NULLIF(left(date::text, 4), ''), 'LEGACY')
  || '-'
  || left(replace(uuid::text, '-', ''), 12)
WHERE number IS NULL;
ALTER TABLE public.expenses ENABLE TRIGGER trg_expenses_lww;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.expenses WHERE number IS NULL) THEN
    RAISE EXCEPTION 'EXPENSE_NUMBER_BACKFILL_INCOMPLETE';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_code
  ON public.projects(code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_number
  ON public.contracts(project_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_certificate_number
  ON public.payment_certificates(contract_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_number
  ON public.payments(contract_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_number
  ON public.expenses(number);

ALTER TABLE public.expenses ALTER COLUMN number SET NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
