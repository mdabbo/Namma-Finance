-- Apply after the existing Supabase schema migrations.
BEGIN;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS number text;
UPDATE public.expenses SET number='EXP-' || COALESCE(left(date::text,4),'LEGACY') || '-' || left(replace(uuid::text,'-',''),12) WHERE number IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_code ON public.projects(code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_number ON public.contracts(project_id,number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_certificate_number ON public.payment_certificates(contract_id,number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_number ON public.payments(contract_id,number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_number ON public.expenses(number);
ALTER TABLE public.expenses ALTER COLUMN number SET NOT NULL;
COMMIT;
