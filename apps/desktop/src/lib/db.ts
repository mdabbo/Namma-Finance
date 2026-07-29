import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { assertRestrictedSql } from "./sqlGuard";

let dbPromise: Promise<Database> | null = null;
export interface RuntimeReleaseInfo {
  appVersion: string;
  schemaVersion: number;
}
let runtimeReleaseInfo: RuntimeReleaseInfo | null = null;

/** Shared SQLx-backed database handle. Migrations run on the Rust side before load resolves. */
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:mep-finance.db").then(async (db) => {
      try {
        runtimeReleaseInfo = await invoke<RuntimeReleaseInfo>("initialize_runtime_release");
        await db.execute("PRAGMA journal_mode=WAL;");
        await db.execute("PRAGMA foreign_keys=ON;");
        return db;
      } catch (error) {
        await db.close().catch(() => undefined);
        runtimeReleaseInfo = null;
        dbPromise = null;
        throw error;
      }
    });
  }
  return dbPromise;
}

export async function getRuntimeReleaseInfo(): Promise<RuntimeReleaseInfo> {
  await getDb();
  if (!runtimeReleaseInfo) throw new Error("RUNTIME_RELEASE_INFO_UNAVAILABLE");
  return runtimeReleaseInfo;
}

export async function select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getDb();
  return db.select<T[]>(sql, params);
}

export async function selectOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await select<T>(sql, params);
  return rows[0] ?? null;
}

export interface ExecResult {
  lastInsertId?: number;
  rowsAffected: number;
}

export { assertRestrictedSql } from "./sqlGuard";

export async function execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
  assertRestrictedSql(sql,params);
  const db = await getDb();
  return db.execute(sql, params);
}

/** Close the pool (needed before restoring a backup). */
export async function closeDb(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  runtimeReleaseInfo = null;
  if (!pending) return;
  const db = await pending;
  await db.close();
}
