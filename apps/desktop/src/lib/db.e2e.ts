import { assertRestrictedSql } from "./sqlGuard";

/**
 * End-to-end stand-in for the Tauri SQL layer.
 *
 * Swapped in for `lib/db.ts` only when Vite runs in `e2e` mode (see
 * vite.config.ts). It forwards to e2e/db-server.mjs, which runs the REAL
 * migration files on a real SQLite engine, so repository code, triggers and
 * financial constraints behave exactly as they do in the shipped app. The SQL
 * guard is shared with production rather than reimplemented, so a mutation the
 * app would refuse is refused here too.
 *
 * One thing behaves differently on purpose: `runInTransaction` works here and
 * throws in production. The WebView cannot own a transaction on a pooled
 * connection, so the shipped app routes multi-statement writes to Rust; this
 * bridge has one synchronous connection and one Playwright worker, so it can
 * give the test doubles a real boundary. Nothing that runs through those
 * doubles is evidence about the Rust commands.
 *
 * This module is never reachable from a production build.
 */

const ENDPOINT = import.meta.env.VITE_E2E_DB ?? "http://127.0.0.1:1425";

export interface RuntimeReleaseInfo {
  appVersion: string;
  schemaVersion: number;
}

export interface ExecResult {
  lastInsertId?: number;
  rowsAffected: number;
}

async function call<T>(route: string, sql: string, params: unknown[]): Promise<T> {
  const response = await fetch(`${ENDPOINT}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "E2E_DB_ERROR");
  return payload as T;
}

/** No pooled handle exists in the browser; kept for surface compatibility. */
export async function getDb(): Promise<unknown> {
  const response = await fetch(`${ENDPOINT}/health`);
  if (!response.ok) throw new Error("E2E_DB_UNAVAILABLE");
  return {};
}

export async function getRuntimeReleaseInfo(): Promise<RuntimeReleaseInfo> {
  const rows = await select<{ key: string; value: string }>(
    "SELECT key, value FROM app_metadata",
  );
  const metadata = new Map(rows.map((row) => [row.key, row.value]));
  return {
    appVersion: metadata.get("application_version") ?? "0.0.0",
    schemaVersion: Number(metadata.get("schema_version") ?? 0),
  };
}

export async function select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await call<{ rows: T[] }>("/select", sql, params);
  return rows;
}

export async function selectOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await select<T>(sql, params);
  return rows[0] ?? null;
}

export { assertRestrictedSql };

export async function execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
  assertRestrictedSql(sql, params);
  return call<ExecResult>("/execute", sql, params);
}

export async function closeDb(): Promise<void> {
  // The bridge owns the database lifetime; tests reset it between specs.
}

async function transaction(action: "begin" | "commit" | "rollback"): Promise<void> {
  const response = await fetch(`${ENDPOINT}/transaction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) throw new Error("E2E_TRANSACTION_FAILED");
}

/**
 * The transaction boundary the WebView is not allowed to open for itself.
 *
 * In the shipped app this throws (see db.ts) and multi-statement writes go
 * through a Rust atomic command. The bridge asks its server for the boundary
 * rather than issuing BEGIN as SQL, because `assertRestrictedSql` refuses
 * transaction control here exactly as in production.
 */
export async function runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
  await transaction("begin");
  try {
    const result = await fn();
    await transaction("commit");
    return result;
  } catch (error) {
    await transaction("rollback");
    throw error;
  }
}

/** Test counterpart of the KNOWN-UNSAFE production remnant (syncConflicts). */
export async function unsafeWebViewTransaction(step: "BEGIN IMMEDIATE" | "COMMIT" | "ROLLBACK"): Promise<void> {
  await transaction(step === "BEGIN IMMEDIATE" ? "begin" : step === "COMMIT" ? "commit" : "rollback");
}
