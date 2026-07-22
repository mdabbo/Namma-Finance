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
