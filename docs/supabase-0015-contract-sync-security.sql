-- NAMAA Finance cloud migration 0015.
-- Apply AFTER supabase-0009-contract-revisions.sql,
-- supabase-0010-contract-revision-integrity.sql, and
-- supabase-security-hardening.sql.
--
-- Forward-only and data-preserving: no financial row is inserted, updated, or
-- deleted. Existing rows are validated before constraints become active.

begin;

-- The original schema-9 cloud delta created these tables without relational
-- constraints. Add them without rewriting either historical migration.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='contract_revisions_contract_fk'
      and conrelid='public.contract_revisions'::regclass
  ) then
    alter table public.contract_revisions
      add constraint contract_revisions_contract_fk
      foreign key(contract_id) references public.contracts(uuid)
      on delete restrict not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname='variation_orders_contract_fk'
      and conrelid='public.variation_orders'::regclass
  ) then
    alter table public.variation_orders
      add constraint variation_orders_contract_fk
      foreign key(contract_id) references public.contracts(uuid)
      on delete restrict not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname='variation_orders_revision_fk'
      and conrelid='public.variation_orders'::regclass
  ) then
    alter table public.variation_orders
      add constraint variation_orders_revision_fk
      foreign key(revision_id) references public.contract_revisions(uuid)
      on delete restrict not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname='payment_certificates_revision_fk'
      and conrelid='public.payment_certificates'::regclass
  ) then
    alter table public.payment_certificates
      add constraint payment_certificates_revision_fk
      foreign key(contract_revision_id) references public.contract_revisions(uuid)
      on delete restrict not valid;
  end if;
end $$;

alter table public.contract_revisions validate constraint contract_revisions_contract_fk;
alter table public.variation_orders validate constraint variation_orders_contract_fk;
alter table public.variation_orders validate constraint variation_orders_revision_fk;
alter table public.payment_certificates validate constraint payment_certificates_revision_fk;

create index if not exists idx_contract_revisions_updated
  on public.contract_revisions(updated_at,uuid);
create index if not exists idx_variation_orders_updated
  on public.variation_orders(updated_at,uuid);
create index if not exists idx_contract_revisions_contract
  on public.contract_revisions(contract_id,effective_date,revision_number);
create index if not exists idx_variation_orders_contract
  on public.variation_orders(contract_id);
create index if not exists idx_payment_certificates_revision
  on public.payment_certificates(contract_revision_id);

-- LWW must run before the approved-record immutability triggers. An older
-- device write is ignored; a newer attempt to alter approved terms is denied.
drop trigger if exists trg_contract_revisions_lww on public.contract_revisions;
drop trigger if exists a_namaa_contract_revisions_lww on public.contract_revisions;
create trigger a_namaa_contract_revisions_lww
  before update on public.contract_revisions
  for each row execute function public.nf_lww_guard();

drop trigger if exists trg_variation_orders_lww on public.variation_orders;
drop trigger if exists a_namaa_variation_orders_lww on public.variation_orders;
create trigger a_namaa_variation_orders_lww
  before update on public.variation_orders
  for each row execute function public.nf_lww_guard();

-- Tables created through the SQL editor do not receive RLS automatically.
alter table public.contract_revisions enable row level security;
alter table public.variation_orders enable row level security;

drop policy if exists office_all on public.contract_revisions;
drop policy if exists namaa_member_read on public.contract_revisions;
drop policy if exists namaa_finance_write on public.contract_revisions;
drop policy if exists office_all on public.variation_orders;
drop policy if exists namaa_member_read on public.variation_orders;
drop policy if exists namaa_finance_write on public.variation_orders;

do $$
begin
  if to_regprocedure('public.nf_is_member()') is not null
     and to_regprocedure('public.nf_can_manage_finance()') is not null then
    execute 'create policy namaa_member_read on public.contract_revisions for select to authenticated using (public.nf_is_member())';
    execute 'create policy namaa_finance_write on public.contract_revisions for all to authenticated using (public.nf_can_manage_finance()) with check (public.nf_can_manage_finance())';
    execute 'create policy namaa_member_read on public.variation_orders for select to authenticated using (public.nf_is_member())';
    execute 'create policy namaa_finance_write on public.variation_orders for all to authenticated using (public.nf_can_manage_finance()) with check (public.nf_can_manage_finance())';
  else
    -- Compatibility with Phase-3 deployments that have not enabled app roles.
    execute 'create policy office_all on public.contract_revisions for all to authenticated using (true) with check (true)';
    execute 'create policy office_all on public.variation_orders for all to authenticated using (true) with check (true)';
  end if;
end $$;

revoke all on table public.contract_revisions from anon;
revoke all on table public.variation_orders from anon;
grant select,insert,update,delete on table public.contract_revisions to authenticated;
grant select,insert,update,delete on table public.variation_orders to authenticated;

commit;

-- Ask PostgREST to expose the new tables/columns immediately.
notify pgrst, 'reload schema';
