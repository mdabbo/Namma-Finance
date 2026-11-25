import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { SYNC_TABLES } from "../src/lib/sync/registry";
import { APPLY_ORDER, docs, SUPABASE_STUBS } from "./cloud-db";

/**
 * The desktop pushes every column in the sync registry to Supabase. A column
 * the cloud tables do not have makes the whole push fail with "Could not find
 * the 'x' column of 'y' in the schema cache" — and nothing after that table in
 * the sync order is exchanged, so the phone and the other PCs stop seeing new
 * data. That is exactly what happened when assignment lifecycle (desktop
 * migration 0003) shipped with no matching cloud script.
 *
 * This runs the real cloud scripts, in the order docs/PHASE3-SETUP.md gives,
 * and checks the result against the registry the desktop actually syncs from.
 */

const CLOUD_UPGRADES = [
  ...APPLY_ORDER,
  "supabase-0018-sync-peers.sql",
  "supabase-0021-time-entry-capture.sql",
  "supabase-0022-assignment-lifecycle.sql",
  "supabase-0023-assignment-contract-fees.sql",
  "supabase-0025-expense-claims.sql",
];

let db: PGlite;
const columns = new Map<string, Set<string>>();

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const file of CLOUD_UPGRADES) await db.exec(docs(file));
  const { rows } = await db.query<{ table_name: string; column_name: string }>(
    "select table_name, column_name from information_schema.columns where table_schema = 'public'",
  );
  for (const { table_name, column_name } of rows) {
    if (!columns.has(table_name)) columns.set(table_name, new Set());
    columns.get(table_name)!.add(column_name);
  }
}, 120_000);

describe("the cloud schema matches what the desktop syncs", () => {
  it("has a table for every synced table", () => {
    expect(SYNC_TABLES.map((spec) => spec.name).filter((name) => !columns.has(name))).toEqual([]);
  });

  it.each(SYNC_TABLES.map((spec) => [spec.name, spec] as const))("%s has every synced column", (_name, spec) => {
    const cloud = columns.get(spec.name) ?? new Set<string>();
    // Identity and the sync cursor/soft-delete columns every synced table carries.
    const needed = ["uuid", "updated_at", "deleted_at"];
    for (const column of spec.columns) needed.push(spec.remoteRenames?.[column] ?? column);
    const missing = [...new Set(needed)].filter((column) => !cloud.has(column));
    expect(missing).toEqual([]);
  });

  it("covers every foreign-key column the registry declares", () => {
    const missing: string[] = [];
    for (const spec of SYNC_TABLES) {
      for (const fk of spec.fks) {
        if (!spec.columns.includes(fk.column)) missing.push(`${spec.name}.${fk.column} is not a synced column`);
        if (!columns.get(spec.name)?.has(fk.column)) missing.push(`${spec.name}.${fk.column} missing in the cloud`);
        if (!columns.has(fk.parent)) missing.push(`${spec.name}.${fk.column} points at unknown ${fk.parent}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("assignment lifecycle in the cloud (desktop migration 0003)", () => {
  const CLIENT = "c0000000-0000-4000-8000-000000000009";
  const PROJECT = "d0000000-0000-4000-8000-000000000009";
  const PERSON = "b0000000-0000-4000-8000-000000000009";

  /** Insert one assignment with the given extra columns; null when it was accepted. */
  async function assignment(fields: string[], values: unknown[]): Promise<string | null> {
    try {
      await db.query("insert into clients (uuid, name, updated_at) values ($1,'C',now()) on conflict do nothing", [CLIENT]);
      await db.query("insert into projects (uuid, code, name, client_id, updated_at) values ($1,'P','P',$2,now()) on conflict do nothing", [PROJECT, CLIENT]);
      await db.query("insert into people (uuid, name, updated_at) values ($1,'X',now()) on conflict do nothing", [PERSON]);
      const extra = fields.map((field) => `, ${field}`).join("");
      const marks = values.map((_, i) => `, $${i + 3}`).join("");
      await db.query(
        `insert into project_assignments (uuid, person_id, project_id, updated_at${extra}) values (gen_random_uuid(), $1, $2, now()${marks})`.replace("$1, $2", "$1::uuid, $2::uuid"),
        [PERSON, PROJECT, ...values],
      );
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  it("keeps an existing assignment active by default", async () => {
    expect(await assignment([], [])).toBeNull();
    const { rows } = await db.query<{ lifecycle_status: string; cancellation_reason: string | null }>(
      "select lifecycle_status, cancellation_reason from project_assignments limit 1",
    );
    expect(rows[0]).toEqual({ lifecycle_status: "ACTIVE", cancellation_reason: null });
  });

  it("accepts a cancelled assignment with its frozen earned amount", async () => {
    expect(
      await assignment(["lifecycle_status", "cancelled_at", "cancellation_reason", "earned_minor_at_cancellation"], ["CANCELLED", "2026-11-01T00:00:00Z", "client withdrew", 125000]),
    ).toBeNull();
  });

  it("rejects a lifecycle status the desktop does not know", async () => {
    expect(await assignment(["lifecycle_status"], ["PAUSED"])).toMatch(/violates check constraint/);
  });

  it("refuses the same impossible rows the desktop refuses", async () => {
    // A cancellation without its date, reason or frozen earned figure.
    expect(await assignment(["lifecycle_status"], ["CANCELLED"])).toMatch(/cancellation_evidence_check/);
    expect(
      await assignment(["lifecycle_status", "cancelled_at", "cancellation_reason", "earned_minor_at_cancellation"], ["CANCELLED", "2026-11-01", "   ", 0]),
    ).toMatch(/cancellation_evidence_check/);
    expect(await assignment(["lifecycle_status"], ["COMPLETED"])).toMatch(/completion_date_check/);
    expect(await assignment(["earned_minor_at_cancellation"], [-1])).toMatch(/earned_nonnegative_check/);
    expect(await assignment(["lifecycle_status", "completed_at"], ["COMPLETED", "2026-11-01"])).toBeNull();
  });

  it("keeps dates exactly as the desktop wrote them", async () => {
    expect(await assignment(["completed_at", "lifecycle_status"], ["2026-11-01 08:30:00", "COMPLETED"])).toBeNull();
    const { rows } = await db.query<{ completed_at: string }>("select completed_at from project_assignments where completed_at like '2026-11-01 08:30:00'");
    expect(rows).toHaveLength(1);
  });

  it("can be applied again without changing anything", async () => {
    const before = await db.query("select count(*)::int as n, count(*) filter (where lifecycle_status = 'ACTIVE')::int as active from project_assignments");
    await db.exec(docs("supabase-0022-assignment-lifecycle.sql"));
    const after = await db.query("select count(*)::int as n, count(*) filter (where lifecycle_status = 'ACTIVE')::int as active from project_assignments");
    expect(after.rows).toEqual(before.rows);
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where conrelid = 'public.project_assignments'::regclass and conname like 'project_assignments_%_check'",
    );
    expect(rows[0].n).toBe(4);
  });
});
