-- Apply after supabase-0010-contract-revision-integrity.sql.
alter table payment_certificate_allocations
  add column if not exists integrity_exception boolean not null default false;

with ranked as (
  select uuid,row_number() over (partition by payment_id,certificate_id order by updated_at,uuid) as rn
  from payment_certificate_allocations
)
update payment_certificate_allocations a set integrity_exception=true
from ranked r where r.uuid=a.uuid and r.rn>1;

create unique index if not exists payment_certificate_allocations_payment_certificate_key
  on payment_certificate_allocations(payment_id,certificate_id) where not integrity_exception;

alter table payment_certificate_allocations
  add constraint payment_certificate_allocations_amount_positive
  check (amount_minor > 0);

-- Contract ownership, lifecycle, payment-total, and unpaid-balance checks are
-- also enforced by the desktop transaction service. Equivalent Supabase RPC
-- validation must be used before enabling direct remote financial writes.
