-- Read-only NAMAA Finance cloud-schema inspection.
-- Safe to run in the Supabase SQL Editor: it does not change any data or DDL.

select jsonb_build_object(
  'contract_revisions_table', to_regclass('public.contract_revisions') is not null,
  'variation_orders_table', to_regclass('public.variation_orders') is not null,
  'user_roles_table', to_regclass('public.user_roles') is not null,
  'lww_function', to_regprocedure('public.nf_lww_guard()') is not null,
  'member_function', to_regprocedure('public.nf_is_member()') is not null,
  'finance_role_function', to_regprocedure('public.nf_can_manage_finance()') is not null,
  'certificate_revision_column', exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_certificates'
      and column_name='contract_revision_id'
  ),
  'certificate_due_confirmation_column', exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_certificates'
      and column_name='due_date_confirmed_at'
  ),
  'managed_document_uuid_column', exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='documents'
      and column_name='document_uuid'
  ),
  'expense_number_column', exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='expenses'
      and column_name='number'
  ),
  'allocation_integrity_column', exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_certificate_allocations'
      and column_name='integrity_exception'
  )
) as namaa_cloud_schema;
