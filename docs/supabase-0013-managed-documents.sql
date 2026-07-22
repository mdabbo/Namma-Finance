-- Run after the existing Supabase sync schema, before syncing desktop schema 18.
-- Machine-specific paths are deliberately removed from remote rows.
alter table public.documents alter column path drop not null;
alter table public.documents add column if not exists document_uuid uuid;
alter table public.documents add column if not exists original_filename text;
alter table public.documents add column if not exists extension text;
alter table public.documents add column if not exists mime_type text not null default 'application/octet-stream';
alter table public.documents add column if not exists size_bytes bigint;
alter table public.documents add column if not exists sha256 text;
alter table public.documents add column if not exists storage_provider text not null default 'LOCAL_ONLY';
alter table public.documents add column if not exists cloud_storage_key text;
alter table public.documents add column if not exists version_number integer not null default 1;
alter table public.documents add column if not exists uploaded_at timestamptz;
alter table public.documents add column if not exists uploaded_by uuid;
alter table public.documents add column if not exists archived_at timestamptz;

update public.documents
set document_uuid=coalesce(document_uuid,uuid),
    original_filename=coalesce(original_filename,title),
    storage_provider=case when cloud_storage_key is null then 'LEGACY_LOCAL' else storage_provider end,
    path=null
where document_uuid is null or original_filename is null or path is not null;

-- These legacy fields contain machine-specific paths and are no longer in the
-- sync registry. Local values remain untouched for backward compatibility.
update public.contracts set attachments=null where attachments is not null;
update public.expenses set attachment_path=null where attachment_path is not null;

alter table public.documents alter column document_uuid set not null;
alter table public.documents alter column original_filename set not null;
alter table public.documents add constraint documents_size_nonnegative check(size_bytes is null or size_bytes>=0);
alter table public.documents add constraint documents_sha256_format check(sha256 is null or sha256~'^[a-f0-9]{64}$');
alter table public.documents add constraint documents_storage_provider check(storage_provider in('LOCAL_ONLY','SUPABASE','LEGACY_LOCAL'));
alter table public.documents add constraint documents_version_positive check(version_number>0);
create unique index if not exists documents_logical_version_unique on public.documents(document_uuid,version_number);

insert into storage.buckets(id,name,public)
values('namaa-documents','namaa-documents',false)
on conflict(id) do update set public=false;

drop policy if exists namaa_documents_read on storage.objects;
drop policy if exists namaa_documents_insert on storage.objects;
drop policy if exists namaa_documents_update on storage.objects;
drop policy if exists namaa_documents_delete on storage.objects;
create policy namaa_documents_read on storage.objects for select to authenticated
 using(bucket_id='namaa-documents' and (storage.foldername(name))[1]=auth.uid()::text);
create policy namaa_documents_insert on storage.objects for insert to authenticated
 with check(bucket_id='namaa-documents' and (storage.foldername(name))[1]=auth.uid()::text);
create policy namaa_documents_update on storage.objects for update to authenticated
 using(bucket_id='namaa-documents' and (storage.foldername(name))[1]=auth.uid()::text)
 with check(bucket_id='namaa-documents' and (storage.foldername(name))[1]=auth.uid()::text);
create policy namaa_documents_delete on storage.objects for delete to authenticated
 using(bucket_id='namaa-documents' and (storage.foldername(name))[1]=auth.uid()::text);
