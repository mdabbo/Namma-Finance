import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Drop-in replacement for src/lib/db.ts used by the simulation harness.
 * Backs the app's real repository code with an in-memory SQLite database
 * created by the REAL migration files, so tests exercise production logic —
 * not a reimplementation.
 *
 * The app speaks Postgres-style `$1..$N` placeholders (tauri-plugin-sql
 * translates them at runtime); node:sqlite wants positional `?`. translate()
 * rewrites each `$N` to `?` and repeats bound values in encounter order, so
 * queries that reference a placeholder more than once (e.g. UPSERT `SET x=$2`)
 * still bind correctly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "src-tauri", "migrations");
const MIGRATIONS = [
  "0001_baseline.sql",
  "0002_seed_reference_data.sql",
  "0003_assignment_lifecycle.sql",
  "0004_cancellation_evidence_integrity.sql",
  "0005_audit_version_baseline.sql",
  "0006_sync_domain_conflict_kind.sql",
  "0007_special_person_payments.sql",
];

let db: DatabaseSync | null = null;

function translate(sql: string, params: unknown[]): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const out = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const v = params[Number(n) - 1];
    values.push(v === undefined ? null : v);
    return "?";
  });
  return { sql: out, values };
}

function requireDb(): DatabaseSync {
  if (!db) throw new Error("harness DB not initialised — call resetDb() first");
  return db;
}

export interface ExecResult {
  lastInsertId?: number;
  rowsAffected: number;
}

export async function select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { sql: s, values } = translate(sql, params);
  return requireDb().prepare(s).all(...(values as never[])) as T[];
}

export async function selectOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await select<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
  const { sql: s, values } = translate(sql, params);
  const r = requireDb().prepare(s).run(...(values as never[]));
  return { lastInsertId: Number(r.lastInsertRowid), rowsAffected: Number(r.changes) };
}

export async function getDb(): Promise<DatabaseSync> {
  return requireDb();
}

/**
 * The transaction boundary the WebView is not allowed to open for itself.
 *
 * In the shipped app this throws (see src/lib/db.ts) and multi-statement writes
 * go through a Rust atomic command. Here there is exactly one synchronous
 * connection and no other writer, so a real SQLite transaction is available and
 * the test doubles behind `atomicCommand` are genuinely atomic — which is what
 * makes the rollback assertions in atomicity.test.ts mean anything.
 *
 * Nested calls join the outer transaction rather than opening a second one,
 * because SQLite has no nested transactions and a repository double may call
 * another one (milestone reconciliation reserves a number, for instance).
 */
let transactionDepth = 0;

export async function runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (transactionDepth > 0) return fn();
  const handle = requireDb();
  handle.exec("BEGIN IMMEDIATE");
  transactionDepth += 1;
  try {
    const result = await fn();
    handle.exec("COMMIT");
    return result;
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  } finally {
    transactionDepth -= 1;
  }
}

export async function closeDb(): Promise<void> {
  db?.close();
  db = null;
}

// ─── test controls (not part of the lib/db surface) ─────────────────────────

/** Fresh in-memory DB with all migrations applied. */
export function resetDb(): void {
  db?.close();
  transactionDepth = 0;
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of MIGRATIONS) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
}

/** Direct query for assertions. */
export function raw<T = Record<string, unknown>>(sql: string): T[] {
  return requireDb().prepare(sql).all() as T[];
}

export function rawOne<T = Record<string, unknown>>(sql: string): T | undefined {
  return requireDb().prepare(sql).get() as T | undefined;
}

/** Execute DDL or failure-injection triggers in integration tests. */
export function rawExec(sql: string): void {
  requireDb().exec(sql);
}

