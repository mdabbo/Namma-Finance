import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Two-device sync test rig.
 *
 * The sync engine imports `../db` (the app's SQLite layer) and `./client`
 * (the Supabase factory). Tests mock both to point here:
 *
 *   - the DB layer is backed by N independent in-memory SQLite databases,
 *     one per simulated device, all built from the REAL migration files, so
 *     the engine and repositories run against production schema/triggers.
 *     One device is "active" at a time; the engine reads/writes that one.
 *
 *   - `makeFakeClient()` returns a faithful in-memory stand-in for the exact
 *     slice of the Supabase/PostgREST query API the engine uses. All fake
 *     clients share one module-level `remote` store, so pushing from device A
 *     and pulling into device B moves real rows between their databases.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "src-tauri", "migrations");
const MIGRATIONS = [
  "0001_initial.sql",
  "0002_seed.sql",
  "0003_feedback_round1.sql",
  "0004_phase2.sql",
  "0005_backfill_team_expenses.sql",
  "0006_sync_tracking.sql",
  "0007_time_tracking.sql",
];

export function buildMigratedDb(through: number = MIGRATIONS.length): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of MIGRATIONS.slice(0, through)) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

// ─── multi-device DB layer (the mocked `../db`) ─────────────────────────────

const devices = new Map<string, DatabaseSync>();
let active: DatabaseSync | null = null;

export function newDevice(id: string): void {
  devices.get(id)?.close();
  const db = buildMigratedDb();
  devices.set(id, db);
  active = db;
}

export function useDevice(id: string): void {
  const db = devices.get(id);
  if (!db) throw new Error(`no device ${id}`);
  active = db;
}

export function deviceDb(id: string): DatabaseSync {
  const db = devices.get(id);
  if (!db) throw new Error(`no device ${id}`);
  return db;
}

export function resetRig(): void {
  for (const db of devices.values()) db.close();
  devices.clear();
  active = null;
  remote.clear();
}

function requireDb(): DatabaseSync {
  if (!active) throw new Error("no active device — call newDevice()/useDevice() first");
  return active;
}

function translate(sql: string, params: unknown[]): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const out = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const v = params[Number(n) - 1];
    values.push(v === undefined ? null : v);
    return "?";
  });
  return { sql: out, values };
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

export async function closeDb(): Promise<void> {
  /* devices are torn down by resetRig(); no-op here */
}

/** Direct query against a specific device (for assertions). */
export function rawOn<T = Record<string, unknown>>(deviceId: string, sql: string, params: unknown[] = []): T[] {
  const { sql: s, values } = translate(sql, params);
  return deviceDb(deviceId).prepare(s).all(...(values as never[])) as T[];
}

export function rawOneOn<T = Record<string, unknown>>(deviceId: string, sql: string, params: unknown[] = []): T | undefined {
  return rawOn<T>(deviceId, sql, params)[0];
}

// ─── fake Supabase remote ───────────────────────────────────────────────────

type Row = Record<string, unknown>;
const remote = new Map<string, Map<string, Row>>();

function tableStore(name: string): Map<string, Row> {
  let m = remote.get(name);
  if (!m) {
    m = new Map();
    remote.set(name, m);
  }
  return m;
}

/** All live (non-tombstoned) remote rows in a table, for assertions. */
export function remoteRows(name: string): Row[] {
  return [...(remote.get(name)?.values() ?? [])];
}

interface QueryResult {
  data: Row[] | null;
  error: { message: string } | null;
}

/**
 * Faithful stand-in for the PostgREST query builder — only the operators the
 * sync engine actually calls. It is a thenable: `await query` runs it.
 */
class FakeQuery implements PromiseLike<QueryResult> {
  private filters: ((r: Row) => boolean)[] = [];
  private orders: [string, boolean][] = [];
  private lim = Infinity;
  private projection: string[] | null = null;
  private mode: "select" | "update" = "select";
  private patch: Row | null = null;

  constructor(private readonly table: string) {}

  select(cols: string): this {
    this.projection = cols === "*" ? null : cols.split(",").map((c) => c.trim());
    return this;
  }

  order(col: string, opts: { ascending: boolean }): this {
    this.orders.push([col, opts.ascending]);
    return this;
  }

  limit(n: number): this {
    this.lim = n;
    return this;
  }

  is(col: string, value: null): this {
    this.filters.push((r) => (r[col] ?? null) === value);
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push((r) => r[col] === value);
    return this;
  }

  /** Only the engine's keyset expression is supported: `A OR (B AND C)`. */
  or(expr: string): this {
    const m = expr.match(/^updated_at\.gt\.(.+?),and\(updated_at\.eq\.(.+?),uuid\.gt\.(.+)\)$/);
    if (!m) throw new Error(`fake supabase: unsupported or() expression: ${expr}`);
    const c1 = Date.parse(m[1]!);
    const c2 = Date.parse(m[2]!);
    const k = m[3]!;
    this.filters.push((r) => {
      const ru = Date.parse(r.updated_at as string);
      return ru > c1 || (ru === c2 && String(r.uuid) > k);
    });
    return this;
  }

  update(patch: Row): this {
    this.mode = "update";
    this.patch = patch;
    return this;
  }

  /**
   * Upsert resolves immediately (not via then). onConflict is always uuid.
   * Models the backend's nf_lww_guard BEFORE UPDATE trigger: an update to an
   * existing row is rejected unless it is strictly newer (inserts are exempt).
   */
  upsert(payload: Row[], _opts: { onConflict: string }): Promise<QueryResult> {
    const store = tableStore(this.table);
    for (const row of payload) {
      const key = String(row.uuid);
      const existing = store.get(key);
      if (existing && Date.parse(row.updated_at as string) <= Date.parse(existing.updated_at as string)) {
        continue; // older-or-equal write loses; stored row stays
      }
      store.set(key, { ...row });
    }
    return Promise.resolve({ data: null, error: null });
  }

  private runSelect(): QueryResult {
    let rows = [...tableStore(this.table).values()].filter((r) => this.filters.every((f) => f(r)));
    if (this.orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const [col, asc] of this.orders) {
          let av: number | string = a[col] as string;
          let bv: number | string = b[col] as string;
          if (col === "updated_at") {
            av = Date.parse(av);
            bv = Date.parse(bv);
          }
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
        }
        return 0;
      });
    }
    rows = rows.slice(0, this.lim);
    if (this.projection) {
      const cols = this.projection;
      rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    }
    return { data: rows.map((r) => ({ ...r })), error: null };
  }

  private runUpdate(): QueryResult {
    const store = tableStore(this.table);
    const patch = this.patch ?? {};
    const patchTs = patch.updated_at as string | undefined;
    for (const row of store.values()) {
      if (!this.filters.every((f) => f(row))) continue;
      // nf_lww_guard: reject an update that is not strictly newer
      if (patchTs && Date.parse(patchTs) <= Date.parse(row.updated_at as string)) continue;
      Object.assign(row, patch);
    }
    return { data: null, error: null };
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      const result = this.mode === "update" ? this.runUpdate() : this.runSelect();
      return Promise.resolve(onfulfilled ? onfulfilled(result) : (result as unknown as TResult1));
    } catch (e) {
      const result: QueryResult = { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      return Promise.resolve(onfulfilled ? onfulfilled(result) : (result as unknown as TResult1));
      void onrejected;
    }
  }
}

export function makeFakeClient() {
  return {
    from: (name: string) => new FakeQuery(name),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "test-user" } } } }),
    },
  };
}
