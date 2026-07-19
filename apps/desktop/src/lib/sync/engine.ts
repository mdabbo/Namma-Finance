import type { SupabaseClient } from "@supabase/supabase-js";
import { execute, select, selectOne } from "../db";
import { getSyncClient } from "./client";
import { SYNC_TABLES, type SyncTableSpec } from "./registry";

/**
 * Two-way sync with the Supabase backend. PULL first (newer remote rows win
 * locally by last-writer-wins), then PUSH (the server's BEFORE UPDATE guard
 * rejects anything older than what it already has). Cursors are keyset
 * (updated_at, id) pairs so ties at the same timestamp — common right after
 * the migration backfill — can never skip rows.
 *
 * Local integer ids never leave the device: FK columns are translated to the
 * parent row's sync_uuid on push and back on pull. Contract milestone JSON
 * carries certificateId/stageId refs — they travel as *Uuid keys remotely and
 * get a fix-up pass after pull (children arrive after their contract).
 */

const PULL_BATCH = 500;
const PUSH_BATCH = 200;

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  pulled: number;
  pushed: number;
  deletedLocal: number;
  deletedRemote: number;
  ok: boolean;
  error?: string;
}

interface LocalRow {
  id: number;
  sync_uuid: string;
  updated_at: string;
  [column: string]: unknown;
}

const normIso = (x: string): string => new Date(x).toISOString();
const nowIso = (): string => new Date().toISOString();

// ─── sync_state ──────────────────────────────────────────────────────────────

async function getState(key: string): Promise<string | null> {
  const row = await selectOne<{ value: string }>("SELECT value FROM sync_state WHERE key = $1", [key]);
  return row?.value ?? null;
}

async function setState(key: string, value: string): Promise<void> {
  await execute(
    "INSERT INTO sync_state (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
    [key, value],
  );
}

interface Cursor {
  u: string; // updated_at watermark (ISO Z)
  k: string; // tie-break key: local id (push) or uuid (pull), as string
}

async function getCursor(kind: "pull" | "push", table: string): Promise<Cursor | null> {
  const raw = await getState(`${kind}:${table}`);
  return raw ? (JSON.parse(raw) as Cursor) : null;
}

async function setCursor(kind: "pull" | "push", table: string, cursor: Cursor): Promise<void> {
  await setState(`${kind}:${table}`, JSON.stringify(cursor));
}

// ─── uuid ↔ local id maps (cached per run) ──────────────────────────────────

class IdMap {
  private toUuid = new Map<number, string | null>();
  private toId = new Map<string, number | null>();
  constructor(private table: string) {}

  async uuidOf(id: number | null | undefined): Promise<string | null> {
    if (id == null) return null;
    if (!this.toUuid.has(id)) {
      const row = await selectOne<{ sync_uuid: string }>(`SELECT sync_uuid FROM ${this.table} WHERE id = $1`, [id]);
      this.toUuid.set(id, row?.sync_uuid ?? null);
      if (row) this.toId.set(row.sync_uuid, id);
    }
    return this.toUuid.get(id) ?? null;
  }

  async idOf(uuid: string | null | undefined): Promise<number | null> {
    if (!uuid) return null;
    if (!this.toId.has(uuid)) {
      const row = await selectOne<{ id: number }>(`SELECT id FROM ${this.table} WHERE sync_uuid = $1`, [uuid]);
      this.toId.set(uuid, row?.id ?? null);
      if (row) this.toUuid.set(row.id, uuid);
    }
    return this.toId.get(uuid) ?? null;
  }

  invalidate(uuid: string, id?: number): void {
    this.toId.delete(uuid);
    if (id !== undefined) this.toUuid.delete(id);
  }
}

type IdMaps = Map<string, IdMap>;
const mapFor = (maps: IdMaps, table: string): IdMap => {
  let m = maps.get(table);
  if (!m) {
    m = new IdMap(table);
    maps.set(table, m);
  }
  return m;
};

// ─── contract milestone JSON refs ───────────────────────────────────────────

interface RawMilestone {
  title?: string;
  percentBp?: number;
  done?: boolean;
  stageId?: number | null;
  certificateId?: number | null;
  stageUuid?: string | null;
  certificateUuid?: string | null;
}

function parseRaw(json: unknown): RawMilestone[] | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as RawMilestone[]) : null;
  } catch {
    return null;
  }
}

/** Local ints → remote uuids (unresolvable ids fall back to stored markers). */
async function milestonesToRemote(json: unknown, maps: IdMaps): Promise<string | null> {
  const arr = parseRaw(json);
  if (!arr) return (json as string | null) ?? null;
  const stages = mapFor(maps, "project_stages");
  const certs = mapFor(maps, "payment_certificates");
  const out = [];
  for (const m of arr) {
    out.push({
      title: m.title ?? "",
      percentBp: m.percentBp ?? 0,
      done: m.done === true,
      stageUuid: (await stages.uuidOf(m.stageId)) ?? m.stageUuid ?? null,
      certificateUuid: (await certs.uuidOf(m.certificateId)) ?? m.certificateUuid ?? null,
    });
  }
  return JSON.stringify(out);
}

/** Remote uuids → local ints; unresolved uuids stay as markers for the fix-up pass. */
async function milestonesToLocal(json: unknown, maps: IdMaps): Promise<string | null> {
  const arr = parseRaw(json);
  if (!arr) return (json as string | null) ?? null;
  const stages = mapFor(maps, "project_stages");
  const certs = mapFor(maps, "payment_certificates");
  const out = [];
  for (const m of arr) {
    out.push({
      title: m.title ?? "",
      percentBp: m.percentBp ?? 0,
      done: m.done === true,
      stageId: await stages.idOf(m.stageUuid),
      certificateId: await certs.idOf(m.certificateUuid),
      stageUuid: m.stageUuid ?? null,
      certificateUuid: m.certificateUuid ?? null,
    });
  }
  return JSON.stringify(out);
}

/**
 * After everything is pulled, resolve milestone refs that arrived before their
 * targets. MUST use FRESH id maps: during the pull pass, idOf(stageUuid) /
 * idOf(certUuid) were queried before those rows existed and the IdMap cached
 * the null result. Reusing that map here would keep returning the cached null,
 * leaving every synced milestone's stageId/certificateId permanently broken.
 */
async function fixupMilestoneRefs(): Promise<void> {
  const freshMaps: IdMaps = new Map();
  const rows = await select<{ id: number; milestones: string }>(
    `SELECT id, milestones FROM contracts
     WHERE milestones LIKE '%Uuid%' AND (milestones LIKE '%"certificateId":null%' OR milestones LIKE '%"stageId":null%')`,
  );
  for (const row of rows) {
    const resolved = await milestonesToLocal(row.milestones, freshMaps);
    if (resolved !== null && resolved !== row.milestones) {
      await execute("UPDATE contracts SET milestones = $1 WHERE id = $2", [resolved, row.id]);
    }
  }
}

// ─── pull ───────────────────────────────────────────────────────────────────

async function pullTable(
  client: SupabaseClient,
  spec: SyncTableSpec,
  maps: IdMaps,
  report: SyncReport,
  purgedUuids: Set<string>,
): Promise<void> {
  const renames = spec.remoteRenames ?? {};
  for (;;) {
    const cursor = await getCursor("pull", spec.name);
    let query = client.from(spec.name).select("*").order("updated_at", { ascending: true }).order("uuid", { ascending: true }).limit(PULL_BATCH);
    if (cursor) {
      query = query.or(`updated_at.gt.${cursor.u},and(updated_at.eq.${cursor.u},uuid.gt.${cursor.k})`);
    }
    const { data, error } = await query;
    if (error) throw new Error(`pull ${spec.name}: ${error.message}`);
    if (!data || data.length === 0) return;

    for (const remote of data as Record<string, unknown>[]) {
      const uuid = remote.uuid as string;
      const remoteUpdated = normIso(remote.updated_at as string);
      const local = await selectOne<LocalRow>(`SELECT * FROM ${spec.name} WHERE sync_uuid = $1`, [uuid]);

      if (remote.deleted_at != null) {
        if (local) {
          await execute(`DELETE FROM ${spec.name} WHERE id = $1`, [local.id]);
          mapFor(maps, spec.name).invalidate(uuid, local.id);
          report.deletedLocal += 1;
        }
        purgedUuids.add(uuid);
      } else if (!local || Date.parse(remoteUpdated) > Date.parse(normIso(local.updated_at))) {
        const values: Record<string, unknown> = {};
        let missingParent = false;
        for (const col of spec.columns) {
          const remoteCol = renames[col] ?? col;
          const fk = spec.fks.find((f) => f.column === col);
          if (fk) {
            const parentId = await mapFor(maps, fk.parent).idOf(remote[remoteCol] as string | null);
            if (parentId === null && remote[remoteCol] != null) missingParent = true;
            values[col] = parentId;
          } else if (spec.hasMilestoneRefs && col === "milestones") {
            values[col] = await milestonesToLocal(remote[remoteCol], maps);
          } else {
            values[col] = remote[remoteCol] ?? null;
          }
        }
        // parents come first in SYNC_TABLES; a missing parent means it was
        // deleted — the child's own deletion is on its way, skip quietly
        if (!missingParent) {
          if (local) {
            const sets = spec.columns.map((c, i) => `${c} = $${i + 1}`).join(", ");
            await execute(
              `UPDATE ${spec.name} SET ${sets}, updated_at = $${spec.columns.length + 1} WHERE id = $${spec.columns.length + 2}`,
              [...spec.columns.map((c) => values[c]), remoteUpdated, local.id],
            );
          } else {
            const cols = [...spec.columns, "sync_uuid", "updated_at"];
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
            await execute(
              `INSERT INTO ${spec.name} (${cols.join(", ")}) VALUES (${placeholders})`,
              [...spec.columns.map((c) => values[c]), uuid, remoteUpdated],
            );
          }
          report.pulled += 1;
        }
      }
      await setCursor("pull", spec.name, { u: remote.updated_at as string, k: uuid });
    }
    if (data.length < PULL_BATCH) return;
  }
}

// ─── push ───────────────────────────────────────────────────────────────────

async function pushTable(
  client: SupabaseClient,
  spec: SyncTableSpec,
  maps: IdMaps,
  report: SyncReport,
): Promise<void> {
  const renames = spec.remoteRenames ?? {};
  for (;;) {
    const cursor = await getCursor("push", spec.name);
    const where = cursor
      ? `WHERE updated_at > $1 OR (updated_at = $1 AND id > $2)`
      : "";
    const params = cursor ? [cursor.u, Number(cursor.k)] : [];
    const rows = await select<LocalRow>(
      `SELECT * FROM ${spec.name} ${where} ORDER BY updated_at, id LIMIT ${PUSH_BATCH}`,
      params,
    );
    if (rows.length === 0) return;

    const payload: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!row.sync_uuid) continue; // pre-migration edge; init trigger will fill on next write
      const out: Record<string, unknown> = {
        uuid: row.sync_uuid,
        updated_at: normIso(row.updated_at),
        deleted_at: null,
      };
      for (const col of spec.columns) {
        const remoteCol = renames[col] ?? col;
        const fk = spec.fks.find((f) => f.column === col);
        if (fk) {
          out[remoteCol] = await mapFor(maps, fk.parent).uuidOf(row[col] as number | null);
        } else if (spec.hasMilestoneRefs && col === "milestones") {
          out[remoteCol] = await milestonesToRemote(row[col], maps);
        } else {
          out[remoteCol] = row[col] ?? null;
        }
      }
      payload.push(out);
    }

    if (payload.length > 0) {
      const { error } = await client.from(spec.name).upsert(payload, { onConflict: "uuid" });
      if (error) throw new Error(`push ${spec.name}: ${error.message}`);
      report.pushed += payload.length;
    }
    const last = rows[rows.length - 1]!;
    await setCursor("push", spec.name, { u: last.updated_at, k: String(last.id) });
    if (rows.length < PUSH_BATCH) return;
  }
}

async function pushTombstones(client: SupabaseClient, report: SyncReport): Promise<void> {
  const tombs = await select<{ id: number; tbl: string; row_uuid: string; deleted_at: string }>(
    "SELECT * FROM sync_tombstones ORDER BY id",
  );
  for (const t of tombs) {
    if (SYNC_TABLES.some((s) => s.name === t.tbl)) {
      const { error } = await client
        .from(t.tbl)
        .update({ deleted_at: normIso(t.deleted_at), updated_at: nowIso() })
        .eq("uuid", t.row_uuid);
      if (error) throw new Error(`delete ${t.tbl}: ${error.message}`);
      report.deletedRemote += 1;
    }
    await execute("DELETE FROM sync_tombstones WHERE id = $1", [t.id]);
  }
}

// ─── first-sync category reconciliation ─────────────────────────────────────

/**
 * Both devices seed the same default expense categories with different
 * random uuids. Before the first push, adopt the remote uuid for any local
 * category with the same English name, so the lists merge instead of doubling.
 */
async function alignSeededCategories(client: SupabaseClient): Promise<void> {
  const { data, error } = await client.from("expense_categories").select("uuid, name_en").is("deleted_at", null);
  if (error) throw new Error(`categories: ${error.message}`);
  if (!data || data.length === 0) return;
  const locals = await select<{ id: number; sync_uuid: string; name_en: string }>(
    "SELECT id, sync_uuid, name_en FROM expense_categories",
  );
  const localUuids = new Set(locals.map((l) => l.sync_uuid));
  for (const local of locals) {
    if (data.some((r) => r.uuid === local.sync_uuid)) continue; // already linked
    const match = data.find((r) => r.name_en === local.name_en && !localUuids.has(r.uuid));
    if (match) {
      await execute("UPDATE expense_categories SET sync_uuid = $1, updated_at = updated_at WHERE id = $2", [match.uuid, local.id]);
      localUuids.add(match.uuid);
    }
  }
}

// ─── orchestration ──────────────────────────────────────────────────────────

let running = false;

export async function runSync(): Promise<SyncReport> {
  if (running) throw new Error("sync already running");
  running = true;
  const report: SyncReport = {
    startedAt: nowIso(),
    finishedAt: "",
    pulled: 0,
    pushed: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    ok: false,
  };
  try {
    const client = await getSyncClient();
    const { data: sessionData } = await client.auth.getSession();
    if (!sessionData.session) throw new Error("not signed in");

    const maps: IdMaps = new Map();
    const purgedUuids = new Set<string>();

    await alignSeededCategories(client);
    for (const spec of SYNC_TABLES) await pullTable(client, spec, maps, report, purgedUuids);
    await fixupMilestoneRefs();

    // tombstones created by applying remote deletions are echoes, not user
    // deletes — drop them so they don't bounce back
    for (const uuid of purgedUuids) {
      await execute("DELETE FROM sync_tombstones WHERE row_uuid = $1", [uuid]);
    }

    await pushTombstones(client, report);
    for (const spec of SYNC_TABLES) await pushTable(client, spec, maps, report);

    report.ok = true;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
  } finally {
    report.finishedAt = nowIso();
    running = false;
    await setState("last_sync", JSON.stringify(report)).catch(() => undefined);
  }
  return report;
}

export async function getLastSyncReport(): Promise<SyncReport | null> {
  const raw = await getState("last_sync");
  return raw ? (JSON.parse(raw) as SyncReport) : null;
}
