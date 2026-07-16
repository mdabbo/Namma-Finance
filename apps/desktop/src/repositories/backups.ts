import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir, join } from "@tauri-apps/api/path";
import { copyFile, exists, mkdir, remove } from "@tauri-apps/plugin-fs";
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
}

export async function listBackups(): Promise<BackupLogEntry[]> {
  const rows = await select<{ id: number; path: string; kind: "AUTO" | "MANUAL"; created_at: string }>(
    "SELECT * FROM backups_log ORDER BY id DESC LIMIT 30",
  );
  return rows.map((r) => ({ id: r.id, path: r.path, kind: r.kind, createdAt: r.created_at }));
}

/** Consistent online backup via SQLite VACUUM INTO (safe under WAL). */
async function backupTo(path: string, kind: "AUTO" | "MANUAL"): Promise<void> {
  if (await exists(path)) await remove(path);
  await execute(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  await execute("INSERT INTO backups_log (path, kind) VALUES ($1, $2)", [path, kind]);
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

  if (settings.backupFolder) {
    try {
      if (await exists(settings.backupFolder)) {
        const drivePath = await join(settings.backupFolder, `mep-finance-${today}.db`);
        await copyFile(path, drivePath);
        await execute("INSERT INTO backups_log (path, kind) VALUES ($1, 'AUTO')", [drivePath]);
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
  await closeDb();
  await invoke("restore_database", { backupPath: path });
  await relaunch();
  return true;
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
