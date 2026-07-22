import { execute, select, selectOne } from "../lib/db";
import { CONFLICT_PROTECTED_TABLES, NUMBER_COLLISION_TABLES } from "../lib/sync/registry";
import { APP_VERSION } from "../generated/release";

export type SyncConflictResolution = "KEEP_LOCAL" | "KEEP_REMOTE";
export interface SyncConflict {
  id: number; table_name: string; row_uuid: string; conflict_kind: string;
  local_json: string; remote_json: string; detected_at: string;
}

export const listOpenSyncConflicts = (): Promise<SyncConflict[]> =>
  select("SELECT id,table_name,row_uuid,conflict_kind,local_json,remote_json,detected_at FROM sync_conflicts WHERE status='OPEN' ORDER BY detected_at DESC");

/** Explicit choice only: no financial row is changed merely by detection. */
export async function resolveSyncConflict(id: number, resolution: SyncConflictResolution, note: string): Promise<void> {
  const conflict = await selectOne<SyncConflict & { remote_updated_at: string }>("SELECT * FROM sync_conflicts WHERE id=$1 AND status='OPEN'", [id]);
  if (!conflict || (!CONFLICT_PROTECTED_TABLES.has(conflict.table_name) && !NUMBER_COLLISION_TABLES.has(conflict.table_name))) throw new Error("SYNC_CONFLICT_NOT_FOUND");
  if (!note.trim()) throw new Error("SYNC_CONFLICT_REASON_REQUIRED");
  await execute("BEGIN IMMEDIATE");
  try {
    const chosenBaseline = resolution === "KEEP_LOCAL" ? conflict.remote_json : conflict.local_json;
    await execute("INSERT INTO sync_record_state(table_name,row_uuid,payload_json,remote_updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(table_name,row_uuid) DO UPDATE SET payload_json=$3,remote_updated_at=$4", [conflict.table_name, conflict.row_uuid, chosenBaseline, conflict.remote_updated_at]);
    const target = await selectOne<{ id: number }>(`SELECT id FROM ${conflict.table_name} WHERE sync_uuid=$1`, [conflict.row_uuid]);
    if (conflict.conflict_kind === "DUPLICATE_RECORD" && conflict.table_name === "payment_certificate_allocations") {
      const local = JSON.parse(conflict.local_json) as { payment_id?: string; certificate_id?: string };
      const duplicate = await selectOne<{ id: number; sync_uuid: string }>(
        `SELECT a.id,a.sync_uuid FROM payment_certificate_allocations a
         JOIN payments p ON p.id=a.payment_id JOIN payment_certificates c ON c.id=a.certificate_id
         WHERE p.sync_uuid=$1 AND c.sync_uuid=$2 AND a.sync_uuid<>$3`,
        [local.payment_id, local.certificate_id, conflict.row_uuid],
      );
      if (!duplicate) throw new Error("SYNC_DUPLICATE_SOURCE_NOT_FOUND");
      if (resolution === "KEEP_LOCAL") {
        await execute("INSERT INTO sync_tombstones(tbl,row_uuid,deleted_at) VALUES('payment_certificate_allocations',$1,$2)", [conflict.row_uuid, new Date().toISOString()]);
      } else {
        // This is an explicit, audited replacement. The allocation delete
        // trigger records the removed financial relationship and its tombstone.
        await execute("DELETE FROM payment_certificate_allocations WHERE id=$1", [duplicate.id]);
      }
    } else if (conflict.conflict_kind === "DUPLICATE_RECORD") {
      const localSnapshot = JSON.parse(conflict.local_json) as { _localSyncUuid?: string };
      const remoteSnapshot = JSON.parse(conflict.remote_json) as { code?: string; number?: string };
      if (!localSnapshot._localSyncUuid) throw new Error("SYNC_DUPLICATE_SOURCE_NOT_FOUND");
      if (resolution === "KEEP_LOCAL") {
        // Number collisions never delete either business record. Explicitly
        // renumber the local record, then replay the pull so both UUIDs and all
        // descendants remain present.
        const config = conflict.table_name === "projects"
          ? { type: "PROJECT", prefixKey: "project_code_prefix", column: "code", dateColumn: "created_at" }
          : conflict.table_name === "contracts"
            ? { type: "CONTRACT", prefixKey: "contract_number_prefix", column: "number", dateColumn: "COALESCE(signed_date,created_at)" }
            : conflict.table_name === "payment_certificates"
              ? { type: "CERTIFICATE", prefixKey: "certificate_number_prefix", column: "number", dateColumn: "date" }
              : conflict.table_name === "payments"
                ? { type: "PAYMENT", prefixKey: "payment_number_prefix", column: "number", dateColumn: "date" }
                : { type: "EXPENSE", prefixKey: "expense_number_prefix", column: "number", dateColumn: "date" };
        const localRecord = await selectOne<{ business_date: string }>(`SELECT ${config.dateColumn} AS business_date FROM ${conflict.table_name} WHERE sync_uuid=$1`, [localSnapshot._localSyncUuid]);
        if (!localRecord) throw new Error("SYNC_DUPLICATE_SOURCE_NOT_FOUND");
        const prefixRow = await selectOne<{ value: string }>("SELECT value FROM settings WHERE key=$1", [config.prefixKey]);
        const prefix = (prefixRow?.value ?? config.type.slice(0, 3)).trim().toUpperCase();
        if (!/^[A-Z0-9]{1,12}$/.test(prefix)) throw new Error("INVALID_NUMBER_PREFIX");
        const parsedYear = Number.parseInt(localRecord.business_date?.slice(0, 4) ?? "", 10);
        const year = parsedYear >= 2000 && parsedYear <= 9999 ? parsedYear : new Date().getUTCFullYear();
        const stem = `${prefix}-${year}-`;
        await execute("INSERT OR IGNORE INTO numbering_sequences(sequence_type,year,prefix,last_number) VALUES($1,$2,$3,0)", [config.type, year, prefix]);
        const existing = await selectOne<{ max_number: number | null }>(`SELECT MAX(CAST(substr(${config.column},length($1)+1) AS INTEGER)) AS max_number FROM ${conflict.table_name} WHERE ${config.column} LIKE $2`, [stem, `${stem}%`]);
        await execute("UPDATE numbering_sequences SET last_number=MAX(last_number,$1)+1 WHERE sequence_type=$2 AND year=$3 AND prefix=$4", [existing?.max_number ?? 0, config.type, year, prefix]);
        const reserved = await selectOne<{ last_number: number }>("SELECT last_number FROM numbering_sequences WHERE sequence_type=$1 AND year=$2 AND prefix=$3", [config.type, year, prefix]);
        if (!reserved) throw new Error("NUMBER_RESERVATION_FAILED");
        const newNumber = `${stem}${String(reserved.last_number).padStart(config.type === "PROJECT" ? 3 : 4, "0")}`;
        await execute(`UPDATE ${conflict.table_name} SET ${config.column}=$1 WHERE sync_uuid=$2`, [newNumber, localSnapshot._localSyncUuid]);
        await execute("INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_uuid,before_json,after_json,reason,source,application_version) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'NUMBER_COLLISION_RENUMBER',$1,$2,json_object('number',$3),json_object('number',$4),$5,'SYNC',$6)", [conflict.table_name, localSnapshot._localSyncUuid, conflict.table_name === "projects" ? remoteSnapshot.code : remoteSnapshot.number, newNumber, note.trim(), APP_VERSION]);
      } else {
        const numberColumn = conflict.table_name === "projects" ? "code" : "number";
        const current = await selectOne<{ human_number: string }>(`SELECT ${numberColumn} AS human_number FROM ${conflict.table_name} WHERE sync_uuid=$1`, [localSnapshot._localSyncUuid]);
        const remoteNumber = conflict.table_name === "projects" ? remoteSnapshot.code : remoteSnapshot.number;
        if (current?.human_number === remoteNumber) throw new Error("RENUMBER_LOCAL_BEFORE_KEEP_REMOTE");
      }
    } else if (resolution === "KEEP_LOCAL" && target) {
      const remoteMs = Date.parse(conflict.remote_updated_at);
      const winningMs = Math.max(Date.now(), Number.isFinite(remoteMs) ? remoteMs + 1 : 0);
      await execute(`UPDATE ${conflict.table_name} SET updated_at=$1 WHERE sync_uuid=$2`, [new Date(winningMs).toISOString(), conflict.row_uuid]);
    } else if (resolution === "KEEP_REMOTE" && target) {
      // Force the next pull to apply the preserved remote snapshot even when
      // the rejected local edit carried a later wall-clock timestamp.
      await execute(`UPDATE ${conflict.table_name} SET updated_at='1970-01-01T00:00:00.000Z' WHERE sync_uuid=$1`, [conflict.row_uuid]);
    } else {
      // KEEP_REMOTE for a locally deleted row must cancel its tombstone,
      // otherwise the selected cloud row would be re-deleted after pull.
      if (resolution === "KEEP_REMOTE") await execute("DELETE FROM sync_tombstones WHERE tbl=$1 AND row_uuid=$2", [conflict.table_name, conflict.row_uuid]);
    }
    await execute("UPDATE sync_conflicts SET status='RESOLVED',resolution=$1,resolution_note=$2,resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),resolved_by=(SELECT value FROM settings WHERE key='sync_email') WHERE id=$3", [resolution, note.trim(), id]);
    if (resolution === "KEEP_REMOTE" || (conflict.conflict_kind === "DUPLICATE_RECORD" && conflict.table_name !== "payment_certificate_allocations")) {
      await execute("DELETE FROM sync_state WHERE key LIKE 'pull:%'");
    }
    await execute("COMMIT");
  } catch (error) {
    await execute("ROLLBACK");
    throw error;
  }
}
