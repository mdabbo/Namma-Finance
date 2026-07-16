import Database from "@tauri-apps/plugin-sql";

let dbPromise: Promise<Database> | null = null;

/** Single shared connection. Migrations run on the Rust side before load resolves. */
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:mep-finance.db").then(async (db) => {
      await db.execute("PRAGMA journal_mode=WAL;");
      await db.execute("PRAGMA foreign_keys=ON;");
      return db;
    });
  }
  return dbPromise;
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

export async function execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
  const db = await getDb();
  return db.execute(sql, params);
}

/** Close the pool (needed before restoring a backup). */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  await db.close();
  dbPromise = null;
}
