import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

let dbPromise: Promise<Database> | null = null;
export interface RuntimeReleaseInfo {
  appVersion: string;
  schemaVersion: number;
}
let runtimeReleaseInfo: RuntimeReleaseInfo | null = null;

/** Single shared connection. Migrations run on the Rust side before load resolves. */
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

/**
 * Defense in depth for the remaining single-record repository mutations.
 * Schema changes, database attachment and stacked statements are available
 * only to Rust migrations/commands, never to feature code in the WebView.
 */
export function assertRestrictedSql(sql: string, params: unknown[]): void {
  const normalized=sql.trim();
  if(!normalized) throw new Error("SQL_EMPTY");
  if(normalized.includes(";") || /--|\/\*/.test(normalized)) throw new Error("SQL_STACKED_OR_COMMENTED");
  if(/^(ATTACH|DETACH|PRAGMA|VACUUM|CREATE|ALTER|DROP|REINDEX)\b/i.test(normalized)) throw new Error("SQL_ADMIN_COMMAND_DENIED");
  const allowed=/^(INSERT|UPDATE|DELETE|BEGIN IMMEDIATE|COMMIT|ROLLBACK)\b/i.test(normalized) || /^WITH\s+chosen\s+AS\s*\(/i.test(normalized);
  if(!allowed) throw new Error("SQL_MUTATION_NOT_ALLOWLISTED");
  const indexes=[...normalized.matchAll(/\$(\d+)/g)].map((match)=>Number(match[1]));
  if(indexes.some((index)=>index<1 || index>params.length)) throw new Error("SQL_PARAMETER_MISSING");
}

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
