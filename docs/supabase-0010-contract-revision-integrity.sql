-- Apply after supabase-0009-contract-revisions.sql.
-- Approved commercial terms remain immutable; sync may still refresh metadata columns.

create or replace function namaa_protect_approved_contract_revision()
returns trigger language plpgsql as $$
begin
  if old.approved_at is not null and (
    new.contract_id is distinct from old.contract_id or
    new.revision_number is distinct from old.revision_number or
    new.effective_date is distinct from old.effective_date or
    new.contract_value_minor is distinct from old.contract_value_minor or
    new.vat_bp is distinct from old.vat_bp or new.retention_bp is distinct from old.retention_bp or
    new.withholding_bp is distinct from old.withholding_bp or new.advance_minor is distinct from old.advance_minor or
    new.advance_recovery_method is distinct from old.advance_recovery_method or
    new.payment_terms_days is distinct from old.payment_terms_days or new.currency is distinct from old.currency or
    new.fx_rate_micro is distinct from old.fx_rate_micro or new.reason is distinct from old.reason or
    new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by or
    new.approved_at is distinct from old.approved_at
  ) then raise exception 'APPROVED_CONTRACT_REVISION_IMMUTABLE'; end if;
  return new;
end $$;

drop trigger if exists protect_approved_contract_revision on contract_revisions;
create trigger protect_approved_contract_revision before update on contract_revisions
for each row execute function namaa_protect_approved_contract_revision();

create or replace function namaa_protect_approved_variation_order()
returns trigger language plpgsql as $$
begin
  if old.approved_at is not null and (
    new.contract_id is distinct from old.contract_id or new.revision_id is distinct from old.revision_id or
    new.number is distinct from old.number or new.description is distinct from old.description or
    new.value_delta_minor is distinct from old.value_delta_minor or new.approved_at is distinct from old.approved_at or
    new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by
  ) then raise exception 'APPROVED_VARIATION_ORDER_IMMUTABLE'; end if;
  return new;
end $$;

drop trigger if exists protect_approved_variation_order on variation_orders;
create trigger protect_approved_variation_order before update on variation_orders
for each row execute function namaa_protect_approved_variation_order();
