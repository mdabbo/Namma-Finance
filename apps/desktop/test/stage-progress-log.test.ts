import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

// The app's real stage repository over the migration-built SQLite harness: the
// history is written by the 0008 triggers, so this exercises the same SQL the
// shipped app runs, whichever writer changes the stage.
vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { execute } from "./db-harness";
import { raw, rawExec, rawOne, resetDb } from "./db-harness";
import { applyMigrations, buildMigratedDb } from "./sync-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { addTemplateStages, createStage, deleteStage, updateStage } from "../src/repositories/stages";
import type { StageInput } from "@mep/core";

interface LogRow {
  stage_uuid: string;
  completion_bp: number;
  recorded_at: string;
  source: string;
  sync_uuid: string;
  updated_at: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function log(): LogRow[] {
  return raw<LogRow>("SELECT stage_uuid,completion_bp,recorded_at,source,sync_uuid,updated_at FROM stage_progress_log ORDER BY id");
}

function stageUuid(id: number): string {
  return rawOne<{ sync_uuid: string }>(`SELECT sync_uuid FROM project_stages WHERE id=${id}`)!.sync_uuid;
}

async function projectFixture(): Promise<number> {
  const clientId = await createClient({ name: "C", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  return createProject("PRJ-2026-001", {
    name: "P", clientId, country: null, city: null, manager: null, discipline: "MULTI",
    projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000,
    startDate: null, endDate: null, progressBp: 0, description: null,
  });
}

function stage(projectId: number, over: Partial<StageInput> = {}): StageInput {
  return {
    projectId, name: "Design", sortOrder: 0, startDate: null, endDate: null,
    status: "IN_PROGRESS", completionBp: 0, engineers: null, notes: null, ...over,
  };
}

describe("stage progress history (migration 0008)", () => {
  beforeEach(() => resetDb());

  it("records the value a stage is created with", async () => {
    const projectId = await projectFixture();
    const id = await createStage(stage(projectId, { completionBp: 1500 }));

    const rows = log();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage_uuid: stageUuid(id), completion_bp: 1500, source: "DESKTOP" });
    expect(rows[0]!.recorded_at).toMatch(ISO);
    expect(rows[0]!.updated_at).toBe(rows[0]!.recorded_at);
    expect(rows[0]!.sync_uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("records one row per change of the value, in order", async () => {
    const projectId = await projectFixture();
    const id = await createStage(stage(projectId));
    await updateStage(id, stage(projectId, { completionBp: 2500 }));
    await updateStage(id, stage(projectId, { completionBp: 6000 }));
    await updateStage(id, stage(projectId, { completionBp: 10_000, status: "COMPLETED" }));

    expect(log().map((row) => row.completion_bp)).toEqual([0, 2500, 6000, 10_000]);
    expect(new Set(log().map((row) => row.stage_uuid))).toEqual(new Set([stageUuid(id)]));
  });

  it("records nothing when an edit leaves the value unchanged", async () => {
    const projectId = await projectFixture();
    const id = await createStage(stage(projectId, { completionBp: 4000 }));
    await updateStage(id, stage(projectId, { completionBp: 4000, name: "Renamed", notes: "n" }));
    await updateStage(id, stage(projectId, { completionBp: 4000, status: "ON_HOLD" }));

    expect(log().map((row) => row.completion_bp)).toEqual([4000]);
  });

  it("records each stage the standard template adds", async () => {
    const projectId = await projectFixture();
    await addTemplateStages(projectId, ["A", "B", "C"]);
    expect(log().map((row) => row.completion_bp)).toEqual([0, 0, 0]);
    expect(new Set(log().map((row) => row.stage_uuid)).size).toBe(3);
  });

  it("does not log a change applied by sync: the origin device logged it", async () => {
    const projectId = await projectFixture();
    const id = await createStage(stage(projectId));
    rawExec(`UPDATE audit_context SET source='SYNC' WHERE id=1;
             UPDATE project_stages SET completion_bp=7000 WHERE id=${id};
             INSERT INTO project_stages(project_id,name,completion_bp,sync_uuid,updated_at)
               VALUES(${projectId},'Pulled',3000,'11111111-1111-4111-8111-111111111111','2026-01-01T00:00:00.000Z');
             UPDATE audit_context SET source='DESKTOP' WHERE id=1;`);

    expect(log().map((row) => row.completion_bp)).toEqual([0]);
  });

  it("logs a stage inserted with its own uuid outside sync", async () => {
    const projectId = await projectFixture();
    rawExec(`INSERT INTO project_stages(project_id,name,completion_bp,sync_uuid)
             VALUES(${projectId},'Imported',4200,'22222222-2222-4222-8222-222222222222')`);
    expect(log()).toEqual([
      expect.objectContaining({ stage_uuid: "22222222-2222-4222-8222-222222222222", completion_bp: 4200 }),
    ]);
  });

  it("cannot be edited or deleted, but sync may advance updated_at", async () => {
    const projectId = await projectFixture();
    await createStage(stage(projectId, { completionBp: 900 }));

    for (const statement of [
      "UPDATE stage_progress_log SET completion_bp=1",
      "UPDATE stage_progress_log SET recorded_at='2020-01-01T00:00:00.000Z'",
      "UPDATE stage_progress_log SET stage_uuid='x'",
      "UPDATE stage_progress_log SET source='FORGED'",
      "UPDATE stage_progress_log SET sync_uuid='y'",
      "DELETE FROM stage_progress_log",
    ]) {
      await expect(execute(statement), statement).rejects.toThrow(/STAGE_PROGRESS_LOG_IMMUTABLE/);
    }
    expect(log().map((row) => row.completion_bp)).toEqual([900]);

    await execute("UPDATE stage_progress_log SET updated_at='2030-01-01T00:00:00.000Z'");
    expect(log()[0]!.updated_at).toBe("2030-01-01T00:00:00.000Z");
  });

  it("keeps the history of a deleted stage, and deleting the stage still works", async () => {
    const projectId = await projectFixture();
    const id = await createStage(stage(projectId, { completionBp: 3000 }));
    const uuid = stageUuid(id);
    await updateStage(id, stage(projectId, { completionBp: 3500 }));

    await deleteStage(id);

    expect(rawOne(`SELECT id FROM project_stages WHERE id=${id}`)).toBeUndefined();
    expect(log().map((row) => [row.stage_uuid, row.completion_bp])).toEqual([[uuid, 3000], [uuid, 3500]]);
  });

  it("a failed stage write leaves no history behind", async () => {
    const projectId = await projectFixture();
    const id = await createStage(stage(projectId, { completionBp: 1000 }));
    // 10001 violates the stage CHECK: the statement, and its log row, roll back.
    await expect(updateStage(id, stage(projectId, { completionBp: 10_001 }))).rejects.toThrow();
    expect(log().map((row) => row.completion_bp)).toEqual([1000]);
  });
});

describe("upgrading an existing database to schema 30", () => {
  let db: DatabaseSync | null = null;
  afterEach(() => {
    db?.close();
    db = null;
  });

  it("records each existing stage's current value once, as a baseline", () => {
    db = buildMigratedDb(7); // schema 29
    db.exec(`INSERT INTO clients(name) VALUES('C');
             INSERT INTO projects(code,name,client_id) VALUES('P-1','P',1);
             INSERT INTO project_stages(project_id,name,completion_bp) VALUES(1,'Concept',10000);
             INSERT INTO project_stages(project_id,name,completion_bp) VALUES(1,'Design',4500);
             INSERT INTO project_stages(project_id,name,completion_bp,sync_uuid,updated_at)
               VALUES(1,'Legacy',2000,NULL,'2026-03-04T05:06:07.000Z');
             UPDATE project_stages SET updated_at='2026-03-04T05:06:07.000Z', sync_uuid=NULL WHERE name='Legacy';`);
    const legacyUpdatedAt = (db.prepare("SELECT updated_at FROM project_stages WHERE name='Legacy'").get() as { updated_at: string }).updated_at;
    expect(legacyUpdatedAt).toBe("2026-03-04T05:06:07.000Z");

    applyMigrations(db, 7);

    const rows = db.prepare(
      `SELECT s.name, l.completion_bp, l.source, l.recorded_at, l.updated_at
         FROM stage_progress_log l JOIN project_stages s ON s.sync_uuid = l.stage_uuid ORDER BY s.id`,
    ).all() as { name: string; completion_bp: number; source: string; recorded_at: string; updated_at: string }[];
    expect(rows.map((row) => [row.name, row.completion_bp, row.source])).toEqual([
      ["Concept", 10_000, "BASELINE"],
      ["Design", 4500, "BASELINE"],
      ["Legacy", 2000, "BASELINE"],
    ]);
    for (const row of rows) {
      expect(row.recorded_at).toMatch(ISO);
      expect(row.updated_at).toBe(row.recorded_at);
    }
    // a stage that never had a uuid receives one, so its history can name it
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_stages WHERE sync_uuid IS NULL").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM stage_progress_log").get()).toEqual({ n: 3 });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 30 });
  });

  it("a stage already carrying a uuid keeps it and is dated by its last change", () => {
    db = buildMigratedDb(7);
    db.exec(`INSERT INTO clients(name) VALUES('C');
             INSERT INTO projects(code,name,client_id) VALUES('P-1','P',1);
             INSERT INTO project_stages(project_id,name,completion_bp) VALUES(1,'Design',4500);
             UPDATE project_stages SET updated_at='2026-02-01T10:00:00.000Z' WHERE id=1;`);
    const before = db.prepare("SELECT sync_uuid FROM project_stages WHERE id=1").get() as { sync_uuid: string };

    applyMigrations(db, 7);

    expect(db.prepare("SELECT sync_uuid FROM project_stages WHERE id=1").get()).toEqual(before);
    expect(db.prepare("SELECT stage_uuid, recorded_at FROM stage_progress_log").get()).toEqual({
      stage_uuid: before.sync_uuid,
      recorded_at: "2026-02-01T10:00:00.000Z",
    });
  });
});
