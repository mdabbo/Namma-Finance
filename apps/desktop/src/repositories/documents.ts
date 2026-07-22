import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DocumentCategory, DocumentInput, DocumentStorageProvider, ProjectDocument } from "@mep/core";
import { documentSchema } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";
import { getSyncClient } from "../lib/sync/client";

const STORAGE_BUCKET = "namaa-documents";

interface ManagedFile {
  originalFilename: string;
  extension: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  localCachePath: string;
}

interface DocumentRow {
  id: number; project_id: number; category: DocumentCategory; title: string;
  document_uuid: string; original_filename: string; extension: string | null; mime_type: string;
  size_bytes: number | null; sha256: string | null; storage_provider: DocumentStorageProvider;
  cloud_storage_key: string | null; device_cache_path: string | null; version_number: number;
  uploaded_at: string | null; uploaded_by: string | null; device_available_offline: number;
  archived_at: string | null; added_at: string;
}

function mapDocument(r: DocumentRow): ProjectDocument {
  return {
    id:r.id, projectId:r.project_id, category:r.category, title:r.title,
    documentUuid:r.document_uuid, originalFilename:r.original_filename, extension:r.extension,
    mimeType:r.mime_type, sizeBytes:r.size_bytes, sha256:r.sha256, storageProvider:r.storage_provider,
    cloudStorageKey:r.cloud_storage_key, localCachePath:r.device_cache_path, versionNumber:r.version_number,
    uploadedAt:r.uploaded_at, uploadedBy:r.uploaded_by, isAvailableOffline:r.device_available_offline===1,
    archivedAt:r.archived_at, addedAt:r.added_at,
  };
}

export async function listDocumentsByProject(projectId: number): Promise<ProjectDocument[]> {
  const rows=await select<DocumentRow>(`SELECT d.*,dc.local_cache_path AS device_cache_path,
    COALESCE(dc.is_available_offline,0) AS device_available_offline
    FROM documents d LEFT JOIN document_cache dc ON dc.document_id=d.id
    WHERE d.project_id=$1 AND d.archived_at IS NULL ORDER BY d.document_uuid,d.version_number DESC,d.id DESC`,[projectId]);
  return rows.map(mapDocument);
}

async function insertDocument(input: DocumentInput): Promise<number> {
  const parsed=documentSchema.parse(input);
  const duplicate=await selectOne<{id:number}>("SELECT id FROM documents WHERE project_id=$1 AND sha256=$2 AND archived_at IS NULL",[parsed.projectId,parsed.sha256]);
  if(duplicate)throw new Error("DUPLICATE_DOCUMENT_CONTENT");
  await execute("BEGIN IMMEDIATE");
  try{
    const result=await execute(
      `INSERT INTO documents(project_id,category,title,document_uuid,original_filename,extension,mime_type,size_bytes,sha256,
         storage_provider,cloud_storage_key,version_number,uploaded_at,uploaded_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [parsed.projectId,parsed.category,parsed.title,parsed.documentUuid,parsed.originalFilename,parsed.extension??null,
        parsed.mimeType,parsed.sizeBytes,parsed.sha256,parsed.storageProvider,parsed.cloudStorageKey??null,
        parsed.versionNumber,parsed.uploadedAt??null,parsed.uploadedBy??null],
    );
    const id=result.lastInsertId??0;
    if(parsed.localCachePath)await execute("INSERT INTO document_cache(document_id,local_cache_path,is_available_offline,verified_at) VALUES($1,$2,$3,datetime('now'))",[id,parsed.localCachePath,parsed.isAvailableOffline?1:0]);
    await execute("COMMIT");
    return id;
  }catch(error){await execute("ROLLBACK").catch(()=>undefined);throw error;}
}

/** Backward-compatible local reference creation. New UI flows use importDocument. */
export async function createDocument(input:{projectId:number;category:DocumentCategory;title:string;path:string}):Promise<number>{
  await execute("BEGIN IMMEDIATE");
  try{
    const result=await execute(`INSERT INTO documents(project_id,category,title,path,document_uuid,original_filename,mime_type,storage_provider,version_number)
      VALUES($1,$2,$3,$4,$5,$3,'application/octet-stream','LEGACY_LOCAL',1)`,[input.projectId,input.category,input.title,input.path,crypto.randomUUID()]);
    const id=result.lastInsertId??0;
    await execute("INSERT INTO document_cache(document_id,local_cache_path,is_available_offline) VALUES($1,$2,1)",[id,input.path]);
    await execute("COMMIT");return id;
  }catch(error){await execute("ROLLBACK").catch(()=>undefined);throw error;}
}

export async function importDocument(projectId:number,category:DocumentCategory,sourcePath:string,logical?:Pick<ProjectDocument,"documentUuid"|"versionNumber">):Promise<number>{
  const documentUuid=logical?.documentUuid??crypto.randomUUID();
  const versionNumber=logical?.versionNumber??1;
  const file=await invoke<ManagedFile>("import_project_document",{sourcePath,documentUuid,versionNumber});
  try{
    return await insertDocument({projectId,category,title:file.originalFilename,documentUuid,versionNumber,
      originalFilename:file.originalFilename,extension:file.extension,mimeType:file.mimeType,sizeBytes:file.sizeBytes,
      sha256:file.sha256,storageProvider:"LOCAL_ONLY",cloudStorageKey:null,localCachePath:file.localCachePath,
      uploadedAt:null,uploadedBy:null,isAvailableOffline:true});
  }catch(error){
    await invoke("remove_managed_document_cache",{path:file.localCachePath}).catch(()=>undefined);
    throw error;
  }
}

export async function addDocumentVersion(document:ProjectDocument,sourcePath:string):Promise<number>{
  const latest=await selectOne<{version:number}>("SELECT MAX(version_number) AS version FROM documents WHERE document_uuid=$1",[document.documentUuid]);
  return importDocument(document.projectId,document.category,sourcePath,{documentUuid:document.documentUuid,versionNumber:(latest?.version??document.versionNumber)+1});
}

export async function updateDocument(id:number,category:DocumentCategory,title:string):Promise<void>{
  await execute("UPDATE documents SET category=$1,title=$2 WHERE id=$3 AND archived_at IS NULL",[category,title,id]);
}

export async function archiveDocument(id:number):Promise<void>{
  await execute("UPDATE documents SET archived_at=datetime('now') WHERE id=$1 AND archived_at IS NULL",[id]);
}

export async function uploadDocument(document:ProjectDocument):Promise<void>{
  if(!document.localCachePath||!document.sha256)throw new Error("DOCUMENT_NOT_AVAILABLE_OFFLINE");
  const client=await getSyncClient();
  const {data:session}=await client.auth.getSession();
  const user=session.session?.user;
  if(!user)throw new Error("NOT_SIGNED_IN");
  const bytes=await readFile(document.localCachePath);
  if(await sha256Hex(bytes)!==document.sha256)throw new Error("DOCUMENT_LOCAL_CHECKSUM_MISMATCH");
  const key=`${user.id}/${document.documentUuid}/v${document.versionNumber}/${document.originalFilename}`;
  const {error}=await client.storage.from(STORAGE_BUCKET).upload(key,bytes,{contentType:document.mimeType,upsert:false});
  if(error){
    if(!/already exists|duplicate/i.test(error.message))throw new Error(error.message);
    const existing=await client.storage.from(STORAGE_BUCKET).download(key);
    if(existing.error)throw new Error(existing.error.message);
    const existingBytes=new Uint8Array(await existing.data.arrayBuffer());
    if(await sha256Hex(existingBytes)!==document.sha256)throw new Error("DOCUMENT_CLOUD_CONFLICT");
  }
  await execute("UPDATE documents SET storage_provider='SUPABASE',cloud_storage_key=$1,uploaded_at=datetime('now'),uploaded_by=$2 WHERE id=$3",[key,user.id,document.id]);
}

export async function downloadDocument(document:ProjectDocument):Promise<void>{
  if(!document.cloudStorageKey||!document.sha256)throw new Error("DOCUMENT_NOT_AVAILABLE_IN_CLOUD");
  const client=await getSyncClient();
  const {data,error}=await client.storage.from(STORAGE_BUCKET).download(document.cloudStorageKey);
  if(error)throw new Error(error.message);
  const file=await invoke<ManagedFile>("cache_project_document",{
    documentUuid:document.documentUuid,versionNumber:document.versionNumber,filename:document.originalFilename,
    bytes:Array.from(new Uint8Array(await data.arrayBuffer())),expectedSha256:document.sha256,
  });
  await execute(`INSERT INTO document_cache(document_id,local_cache_path,is_available_offline,verified_at)
    VALUES($1,$2,1,datetime('now')) ON CONFLICT(document_id) DO UPDATE SET local_cache_path=$2,is_available_offline=1,verified_at=datetime('now')`,[document.id,file.localCachePath]);
}

export async function sha256Hex(bytes:Uint8Array):Promise<string>{
  const digest=await crypto.subtle.digest("SHA-256",new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,"0")).join("");
}

export function useDocumentsByProject(projectId:number){
  return useQuery({queryKey:["documents",projectId],queryFn:()=>listDocumentsByProject(projectId)});
}
export function useDocumentMutations(){
  const qc=useQueryClient();
  const invalidate=()=>void qc.invalidateQueries({queryKey:["documents"]});
  return {
    importFile:useMutation({mutationFn:(v:{projectId:number;category:DocumentCategory;path:string})=>importDocument(v.projectId,v.category,v.path),onSettled:invalidate}),
    addVersion:useMutation({mutationFn:(v:{document:ProjectDocument;path:string})=>addDocumentVersion(v.document,v.path),onSettled:invalidate}),
    update:useMutation({mutationFn:(v:{id:number;category:DocumentCategory;title:string})=>updateDocument(v.id,v.category,v.title),onSettled:invalidate}),
    archive:useMutation({mutationFn:archiveDocument,onSettled:invalidate}),
    upload:useMutation({mutationFn:uploadDocument,onSettled:invalidate}),
    download:useMutation({mutationFn:downloadDocument,onSettled:invalidate}),
  };
}
