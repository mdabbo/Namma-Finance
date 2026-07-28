import { useQuery } from "@tanstack/react-query";
import { execute, select } from "../lib/db";

export interface AuditRecord {
  id: number;
  timestamp: string;
  userId: string | null;
  deviceId: string;
  action: string;
  entityType: string;
  entityId: number | null;
  entityUuid: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  reason: string | null;
  source: string;
  applicationVersion: string;
}

export interface AuditFilters {
  dateFrom?: string;
  dateTo?: string;
  entityType?: string;
  userId?: string;
  action?: string;
}

const PROJECTION = `id,timestamp,user_id AS userId,device_id AS deviceId,action,
 entity_type AS entityType,entity_id AS entityId,entity_uuid AS entityUuid,
 before_json AS beforeJson,after_json AS afterJson,reason,source,
 application_version AS applicationVersion`;

export async function listAuditRecords(filters: AuditFilters = {}): Promise<AuditRecord[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => { params.push(value); clauses.push(clause.replace("?", `$${params.length}`)); };
  if (filters.dateFrom) add("timestamp >= ?", `${filters.dateFrom}T00:00:00.000Z`);
  if (filters.dateTo) add("timestamp <= ?", `${filters.dateTo}T23:59:59.999Z`);
  if (filters.entityType) add("entity_type = ?", filters.entityType);
  if (filters.userId) add("COALESCE(user_id,'') = ?", filters.userId);
  if (filters.action) add("action = ?", filters.action);
  return select<AuditRecord>(`SELECT ${PROJECTION} FROM audit_logs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 1000`, params);
}

export function listEntityHistory(entityType: string, entityId: number | null, entityUuid: string | null): Promise<AuditRecord[]> {
  return select<AuditRecord>(
    `SELECT ${PROJECTION} FROM audit_logs WHERE entity_type=$1
       AND (($2 IS NOT NULL AND entity_id=$2) OR ($2 IS NULL AND $3 IS NOT NULL AND entity_uuid=$3))
     ORDER BY id`,
    [entityType, entityId, entityUuid],
  );
}

export function useAuditRecords(filters: AuditFilters) {
  return useQuery({ queryKey: ["audit", filters], queryFn: () => listAuditRecords(filters) });
}

export function listRecentAuditRecords(limit = 6): Promise<AuditRecord[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.trunc(limit)));
  return select<AuditRecord>(
    `SELECT ${PROJECTION} FROM audit_logs
     WHERE source <> 'BACKGROUND'
     ORDER BY id DESC LIMIT $1`,
    [safeLimit],
  );
}

export function useRecentAuditRecords(limit = 6) {
  return useQuery({
    queryKey: ["audit", "recent", limit],
    queryFn: () => listRecentAuditRecords(limit),
  });
}

export function listProjectAuditRecords(
  projectId: number,
  limit = 8,
  operationalOnly = false,
): Promise<AuditRecord[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.trunc(limit)));
  return select<AuditRecord>(
    `SELECT ${PROJECTION} FROM audit_logs a
     WHERE a.source <> 'BACKGROUND'
       AND ($3=0 OR a.entity_type IN ('project','project_stage','time_entry'))
       AND (
       (a.entity_type='project' AND a.entity_id=$1)
       OR (a.entity_type='contract' AND EXISTS(
         SELECT 1 FROM contracts c WHERE c.id=a.entity_id AND c.project_id=$1
       ))
       OR (a.entity_type='contract_revision' AND EXISTS(
         SELECT 1 FROM contract_revisions r
         JOIN contracts c ON c.id=r.contract_id
         WHERE r.id=a.entity_id AND c.project_id=$1
       ))
       OR (a.entity_type='variation_order' AND EXISTS(
         SELECT 1 FROM variation_orders v
         JOIN contracts c ON c.id=v.contract_id
         WHERE v.id=a.entity_id AND c.project_id=$1
       ))
       OR (a.entity_type='payment_certificate' AND EXISTS(
         SELECT 1 FROM payment_certificates pc
         JOIN contracts c ON c.id=pc.contract_id
         WHERE pc.id=a.entity_id AND c.project_id=$1
       ))
       OR (a.entity_type='payment' AND EXISTS(
         SELECT 1 FROM payments pm
         JOIN contracts c ON c.id=pm.contract_id
         WHERE pm.id=a.entity_id AND c.project_id=$1
       ))
       OR (a.entity_type='payment_allocation' AND EXISTS(
         SELECT 1 FROM payment_certificate_allocations pa
         JOIN payments pm ON pm.id=pa.payment_id
         JOIN contracts c ON c.id=pm.contract_id
         WHERE pa.id=a.entity_id AND c.project_id=$1
       ))
       OR (a.entity_type='expense' AND EXISTS(
         SELECT 1 FROM expenses e WHERE e.id=a.entity_id AND e.project_id=$1
       ))
       OR (a.entity_type='project_stage' AND EXISTS(
         SELECT 1 FROM project_stages s WHERE s.id=a.entity_id AND s.project_id=$1
       ))
       OR (a.entity_type='project_assignment' AND EXISTS(
         SELECT 1 FROM project_assignments pa WHERE pa.id=a.entity_id AND pa.project_id=$1
       ))
       OR (a.entity_type='person_payment' AND EXISTS(
         SELECT 1 FROM person_payments pp
         JOIN project_assignments pa ON pa.id=pp.assignment_id
         WHERE pp.id=a.entity_id AND pa.project_id=$1
       ))
       OR (a.entity_type='time_entry' AND EXISTS(
         SELECT 1 FROM time_entries te WHERE te.id=a.entity_id AND te.project_id=$1
       ))
       OR (
         a.entity_type IN ('project_stage','project_assignment','time_entry','expense')
         AND COALESCE(
           json_extract(a.after_json,'$.projectId'),
           json_extract(a.before_json,'$.projectId')
         )=$1
       )
     )
     ORDER BY a.id DESC LIMIT $2`,
    [projectId, safeLimit, operationalOnly ? 1 : 0],
  );
}

export function useProjectAuditRecords(projectId: number, limit = 8, operationalOnly = false) {
  return useQuery({
    queryKey: ["audit", "project", projectId, limit, operationalOnly],
    queryFn: () => listProjectAuditRecords(projectId, limit, operationalOnly),
  });
}

export function useEntityHistory(record: AuditRecord | null) {
  return useQuery({
    queryKey: ["audit", "entity", record?.entityType, record?.entityId, record?.entityUuid],
    queryFn: () => listEntityHistory(record!.entityType, record!.entityId, record!.entityUuid),
    enabled: record !== null,
  });
}

/** Convert the compatibility marker left when restoring a pre-audit backup. */
export async function finalizePendingRestoreAudit(): Promise<void> {
  const pending = await select<{ value: string }>("SELECT value FROM settings WHERE key='pending_restore_audit'");
  if (!pending.length) return;
  await execute("BEGIN IMMEDIATE");
  try {
    await execute("INSERT INTO audit_logs(user_id,device_id,action,entity_type,after_json,reason,source) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'RESTORE','backup',json_object('path','[REDACTED]'),'Pre-audit database restored by user','RESTORE')");
    await execute("DELETE FROM settings WHERE key='pending_restore_audit'");
    await execute("COMMIT");
  } catch (error) {
    await execute("ROLLBACK");
    throw error;
  }
}
