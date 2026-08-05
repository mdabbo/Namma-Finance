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

/**
 * Refused in the shipped app, by design.
 *
 * The WebView cannot own a transaction: `tauri-plugin-sql` releases the pooled
 * connection between statements, so a boundary opened here would be stranded on
 * a connection any other caller can pick up mid-transaction. Multi-statement
 * writes go through a Rust atomic command, which holds one connection for the
 * whole transaction.
 *
 * The vitest harness and the Playwright bridge replace this module wholesale
 * and implement this against their own single connection, which is why the
 * test doubles behind `atomicCommand` are still atomic there.
 */
export async function runInTransaction<T>(_fn: () => Promise<T>): Promise<T> {
  throw new Error("TRANSACTION_REQUIRES_RUST_COMMAND");
}

/**
 * KNOWN UNSAFE — one remaining caller: `resolveSyncConflict`.
 *
 * This is the WebView transaction described above, with every hazard intact: it
 * is stranded on the shared pooled connection, and a concurrent statement joins
 * it and commits or rolls back with it. It is retained ONLY because sync
 * conflict resolution reads inside its own boundary to decide later writes, so
 * it needs a Rust command of its own rather than a mechanical conversion, and
 * removing the boundary outright would be worse than the race.
 *
 * It bypasses `assertRestrictedSql` deliberately, so the guard can stay strict
 * for everything else and this path cannot be reached by accident. Do not add
 * callers. `test/security.test.ts` pins the caller list at exactly one.
 */
export async function unsafeWebViewTransaction(step: "BEGIN IMMEDIATE" | "COMMIT" | "ROLLBACK"): Promise<void> {
  const db = await getDb();
  await db.execute(step);
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
