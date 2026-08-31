-- DESTRUCTIVE TEST-DATA RESET.
-- Run only when every NAMAA Finance business record in this Supabase project
-- is disposable test data. Authentication users and public.user_roles are
-- intentionally preserved. The database schema and migrations are preserved.

BEGIN;

TRUNCATE TABLE
  public.payment_certificate_allocations,
  public.expenses,
  public.person_payments,
  public.payments,
  public.payment_certificates,
  public.variation_orders,
  public.contract_revisions,
  public.time_entries,
  public.project_assignments,
  public.documents,
  public.project_stages,
  public.contracts,
  public.projects,
  public.expense_categories,
  public.people,
  public.clients,
  public.recurring_expenses
RESTART IDENTITY CASCADE;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Verification: every count returned here must be zero.
SELECT jsonb_build_object(
  'clients', (SELECT count(*) FROM public.clients),
  'people', (SELECT count(*) FROM public.people),
  'expense_categories', (SELECT count(*) FROM public.expense_categories),
  'projects', (SELECT count(*) FROM public.projects),
  'contracts', (SELECT count(*) FROM public.contracts),
  'project_stages', (SELECT count(*) FROM public.project_stages),
  'contract_revisions', (SELECT count(*) FROM public.contract_revisions),
  'variation_orders', (SELECT count(*) FROM public.variation_orders),
  'documents', (SELECT count(*) FROM public.documents),
  'time_entries', (SELECT count(*) FROM public.time_entries),
  'project_assignments', (SELECT count(*) FROM public.project_assignments),
  'payment_certificates', (SELECT count(*) FROM public.payment_certificates),
  'payments', (SELECT count(*) FROM public.payments),
  'payment_certificate_allocations', (SELECT count(*) FROM public.payment_certificate_allocations),
  'person_payments', (SELECT count(*) FROM public.person_payments),
  'expenses', (SELECT count(*) FROM public.expenses),
  'recurring_expenses', (SELECT count(*) FROM public.recurring_expenses)
) AS namaa_test_reset;
