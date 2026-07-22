import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir, dirname, join } from "@tauri-apps/api/path";
import { exists, mkdir, remove } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { closeDb, execute, select } from "../lib/db";
import { loadSettings, saveSetting } from "../lib/settings";
import { todayIso } from "../lib/format";

export interface BackupLogEntry {
  id: number;
  path: string;
  kind: "AUTO" | "MANUAL";
  createdAt: string;
  filename: string;
  databaseVersion: number | null;
  applicationVersion: string | null;
  sha256Checksum: string | null;
  backupType: string;
  sourceDevice: string | null;
}

interface BackupInspection { filename: string; databaseVersion: number; applicationVersion: string; sha256Checksum: string }

export async function listBackups(): Promise<BackupLogEntry[]> {
  const rows = await select<{ id: number; path: string; kind: "AUTO" | "MANUAL"; created_at: string; filename: string | null; database_version: number | null; application_version: string | null; sha256_checksum: string | null; backup_type: string | null; source_device: string | null }>(
    "SELECT * FROM backups_log ORDER BY id DESC LIMIT 30",
  );
  return rows.map((r) => ({ id:r.id,path:r.path,kind:r.kind,createdAt:r.created_at,filename:r.filename??r.path,databaseVersion:r.database_version,applicationVersion:r.application_version,sha256Checksum:r.sha256_checksum,backupType:r.backup_type??r.kind,sourceDevice:r.source_device }));
}

/** Consistent online backup via SQLite VACUUM INTO (safe under WAL). */
async function backupTo(path: string, kind: "AUTO" | "MANUAL"): Promise<void> {
  await invoke<BackupInspection>("create_backup_file",{destinationPath:path,backupType:kind});
}

async function pruneAutomaticBackups(directory: string, keep: number): Promise<void> {
  const rows=await select<{id:number;path:string}>("SELECT id,path FROM backups_log WHERE backup_type='AUTO' ORDER BY created_at DESC,id DESC");
  const scoped: typeof rows=[];
  for(const row of rows) if((await dirname(row.path)).toLocaleLowerCase()===(await dirname(await join(directory,"placeholder"))).toLocaleLowerCase()) scoped.push(row);
  for(const row of scoped.slice(keep)){
    if(await exists(row.path)) await remove(row.path);
    await execute("DELETE FROM backups_log WHERE id=$1",[row.id]);
  }
}

/**
 * Once per day on startup, into <app-data>/backups/. If an extra backup
 * folder is configured (e.g. the user's Google Drive folder), the backup is
 * copied there too so Google Drive for Desktop uploads it automatically.
 */
export async function runDailyBackupIfDue(): Promise<boolean> {
  const settings = await loadSettings();
  const today = todayIso();
  if (settings.lastAutoBackupDate === today) return false;
  const dir = await join(await appConfigDir(), "backups");
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  const path = await join(dir, `mep-finance-${today}.db`);
  await backupTo(path, "AUTO");
  await saveSetting("lastAutoBackupDate", today);
  await pruneAutomaticBackups(dir,settings.backupRetentionCount);

  if (settings.backupFolder) {
    try {
      if (await exists(settings.backupFolder)) {
        const drivePath = await join(settings.backupFolder, `mep-finance-${today}.db`);
        await backupTo(drivePath,"AUTO");
        await pruneAutomaticBackups(settings.backupFolder,settings.backupRetentionCount);
      }
    } catch (err) {
      console.error("backup-folder copy failed", err);
    }
  }
  return true;
}

export async function manualBackup(): Promise<string | null> {
  const path = await save({
    title: "Backup",
    defaultPath: `mep-finance-backup-${todayIso()}.db`,
    filters: [{ name: "SQLite backup", extensions: ["db"] }],
  });
  if (!path) return null;
  await backupTo(path, "MANUAL");
  return path;
}

/** Replace the database with a chosen backup file, then relaunch the app. */
export async function restoreFromBackup(): Promise<boolean> {
  const path = await open({
    title: "Restore",
    multiple: false,
    filters: [{ name: "SQLite backup", extensions: ["db"] }],
  });
  if (!path || typeof path !== "string") return false;
  await invoke("validate_backup", { backupPath: path });
  await closeDb();
  await invoke("restore_database", { backupPath: path });
  await relaunch();
  return true;
}

export async function finalizePendingBackupMetadata(): Promise<void> {
  const rows=await select<{value:string}>("SELECT value FROM settings WHERE key='pending_restore_safety'");
  if(!rows.length)return;
  const value=JSON.parse(rows[0]!.value) as {path:string;filename:string;databaseVersion:number;applicationVersion:string;sha256Checksum:string;sourceDevice:string};
  await execute("BEGIN IMMEDIATE");
  try{
    await execute("INSERT INTO backups_log(path,kind,filename,database_version,application_version,sha256_checksum,backup_type,source_device) VALUES($1,'AUTO',$2,$3,$4,$5,'SAFETY',$6)",[value.path,value.filename,value.databaseVersion,value.applicationVersion,value.sha256Checksum,value.sourceDevice]);
    await execute("DELETE FROM settings WHERE key='pending_restore_safety'");
    await execute("COMMIT");
  }catch(error){await execute("ROLLBACK");throw error;}
}

export function useBackups() {
  return useQuery({ queryKey: ["backups"], queryFn: listBackups });
}

export function useBackupMutations() {
  const qc = useQueryClient();
  return {
    backupNow: useMutation({
      mutationFn: manualBackup,
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["backups"] }),
    }),
    restore: useMutation({ mutationFn: restoreFromBackup }),
  };
}
