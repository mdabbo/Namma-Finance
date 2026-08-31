-- Read-only report for cloud numbering collisions that block migration 0014.
-- This query does not change records, indexes, or constraints.

with collisions as (
  select
    'projects'::text as table_name,
    code::text as business_key,
    count(*)::bigint as duplicate_count,
    jsonb_agg(
      jsonb_build_object(
        'uuid',uuid,
        'code',code,
        'name',name,
        'status',status,
        'client_id',client_id,
        'updated_at',updated_at,
        'deleted_at',deleted_at,
        'contracts',(select count(*) from public.contracts c where c.project_id=projects.uuid),
        'stages',(select count(*) from public.project_stages s where s.project_id=projects.uuid),
        'expenses',(select count(*) from public.expenses e where e.project_id=projects.uuid)
      ) order by updated_at,uuid
    ) as records
  from public.projects
  group by code
  having count(*)>1

  union all

  select
    'contracts',
    project_id::text || ' / ' || number,
    count(*),
    jsonb_agg(
      jsonb_build_object(
        'uuid',uuid,
        'project_id',project_id,
        'number',number,
        'title',title,
        'value_minor',value_minor,
        'updated_at',updated_at,
        'deleted_at',deleted_at,
        'certificates',(select count(*) from public.payment_certificates pc where pc.contract_id=contracts.uuid),
        'payments',(select count(*) from public.payments p where p.contract_id=contracts.uuid)
      ) order by updated_at,uuid
    )
  from public.contracts
  group by project_id,number
  having count(*)>1

  union all

  select
    'payment_certificates',
    contract_id::text || ' / ' || number,
    count(*),
    jsonb_agg(
      jsonb_build_object(
        'uuid',uuid,
        'contract_id',contract_id,
        'number',number,
        'status',status,
        'gross_minor',gross_minor,
        'date',date,
        'updated_at',updated_at,
        'deleted_at',deleted_at
      ) order by updated_at,uuid
    )
  from public.payment_certificates
  group by contract_id,number
  having count(*)>1

  union all

  select
    'payments',
    contract_id::text || ' / ' || number,
    count(*),
    jsonb_agg(
      jsonb_build_object(
        'uuid',uuid,
        'contract_id',contract_id,
        'number',number,
        'amount_minor',amount_minor,
        'date',date,
        'updated_at',updated_at,
        'deleted_at',deleted_at
      ) order by updated_at,uuid
    )
  from public.payments
  group by contract_id,number
  having count(*)>1
)
select table_name,business_key,duplicate_count,records
from collisions
order by table_name,business_key;
