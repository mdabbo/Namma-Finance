import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Back the sync engine's DB layer and Supabase client with the two-device rig.
vi.mock("../src/lib/db", async () => await import("./sync-harness"));
vi.mock("../src/lib/sync/client", async () => {
  const rig = await import("./sync-harness");
  return {
    getSyncClient: async () => rig.makeFakeClient(),
    resetSyncClient: () => undefined,
    SyncNotConfiguredError: class extends Error {},
  };
});

import { runSync } from "../src/lib/sync/engine";
import {
  execute,
  newDevice,
  rawOn,
  rawOneOn,
  remoteRows,
  resetRig,
  useDevice,
} from "./sync-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createStage, updateStage } from "../src/repositories/stages";
import { reconcileMilestoneCertificates } from "../src/repositories/milestoneCertificates";

/** Run a full sync on a given device against the shared remote. */
async function sync(deviceId: string) {
  useDevice(deviceId);
  const report = await runSync();
  if (!report.ok) throw new Error(`sync(${deviceId}) failed: ${report.error}`);
  return report;
}

/** Stamp updated_at explicitly so LWW ordering is deterministic (the touch
 *  trigger only overrides when the statement left updated_at unchanged). */
async function stamp(table: string, id: number, iso: string) {
  await execute(`UPDATE ${table} SET updated_at = $1 WHERE id = $2`, [iso, id]);
}

beforeEach(() => resetRig());
afterEach(() => resetRig());

describe("two-device round-trip", () => {
  it("moves a full client→project→contract chain from A to B with FK translation", async () => {
    newDevice("A");
    const clientId = await createClient({ name: "Cairo Client", company: "MEP Co", address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const code = "PRJ-2026-001";
    const projectId = await createProject(code, {
      name: "Tower HVAC", clientId, country: "Egypt", city: "Cairo", manager: null,
      discipline: "HVAC", projectType: null, status: "ACTIVE", currency: "EGP",
      fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null,
    });
    await createContract({
      projectId, number: "C-1", title: null, valueMinor: 100_000_00, vatBp: 1400, retentionBp: 500,
      withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
      performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
      valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null,
    });

    await sync("A");

    newDevice("B");
    await sync("B");

    const clients = rawOn("B", "SELECT name, company FROM clients");
    expect(clients).toEqual([{ name: "Cairo Client", company: "MEP Co" }]);

    // FK was translated remote-uuid → B's own local id, and it points at the right client
    const project = rawOneOn<{ name: string; client_id: number }>("B", "SELECT name, client_id FROM projects");
    const bClientId = rawOneOn<{ id: number }>("B", "SELECT id FROM clients")!.id;
    expect(project).toMatchObject({ name: "Tower HVAC", client_id: bClientId });

    const contract = rawOneOn<{ number: string; project_id: number }>("B", "SELECT number, project_id FROM contracts");
    const bProjectId = rawOneOn<{ id: number }>("B", "SELECT id FROM projects")!.id;
    expect(contract).toMatchObject({ number: "C-1", project_id: bProjectId });
  });

  it("local integer ids differ between devices but sync_uuid matches", async () => {
    newDevice("A");
    // burn a few ids on B so autoincrement diverges
    newDevice("B");
    await createClient({ name: "x", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    await createClient({ name: "y", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });

    useDevice("A");
    await createClient({ name: "Shared", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    await sync("A");
    await sync("B");

    const aRow = rawOneOn<{ id: number; sync_uuid: string }>("A", "SELECT id, sync_uuid FROM clients WHERE name='Shared'")!;
    const bRow = rawOneOn<{ id: number; sync_uuid: string }>("B", "SELECT id, sync_uuid FROM clients WHERE name='Shared'")!;
    expect(aRow.sync_uuid).toBe(bRow.sync_uuid);
    expect(aRow.id).not.toBe(bRow.id); // B already had 2 clients
  });
});

describe("last-writer-wins conflict", () => {
  it("the later edit wins on both devices after a sync round", async () => {
    newDevice("A");
    const id = await createClient({ name: "Original", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    await stamp("clients", id, "2026-07-01T00:00:00.000Z");
    await sync("A");

    newDevice("B");
    await sync("B");
    const bId = rawOneOn<{ id: number }>("B", "SELECT id FROM clients")!.id;

    // A edits earlier, B edits later
    useDevice("A");
    await execute("UPDATE clients SET name='A-edit', updated_at='2026-07-02T00:00:00.000Z' WHERE id=$1", [id]);
    useDevice("B");
    await execute("UPDATE clients SET name='B-edit', updated_at='2026-07-03T00:00:00.000Z' WHERE id=$1", [bId]);

    await sync("A"); // pushes A-edit
    await sync("B"); // pulls A-edit (older, ignored), pushes B-edit
    await sync("A"); // pulls B-edit (newer, wins)

    expect(rawOneOn<{ name: string }>("A", "SELECT name FROM clients")!.name).toBe("B-edit");
    expect(rawOneOn<{ name: string }>("B", "SELECT name FROM clients")!.name).toBe("B-edit");
  });
});

describe("deletions", () => {
  it("propagate to the other device and leave no bouncing tombstone", async () => {
    newDevice("A");
    const id = await createClient({ name: "ToDelete", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    await sync("A");
    newDevice("B");
    await sync("B");
    expect(rawOn("B", "SELECT id FROM clients")).toHaveLength(1);

    useDevice("A");
    await execute("DELETE FROM clients WHERE id=$1", [id]);
    await sync("A"); // pushes tombstone
    await sync("B"); // pulls delete

    expect(rawOn("B", "SELECT id FROM clients")).toHaveLength(0);
    // B applied the delete but must NOT have queued its own tombstone (echo guard)
    expect(rawOn("B", "SELECT id FROM sync_tombstones")).toHaveLength(0);

    // a further round must not resurrect the row on either side
    await sync("A");
    await sync("B");
    expect(rawOn("A", "SELECT id FROM clients")).toHaveLength(0);
    expect(rawOn("B", "SELECT id FROM clients")).toHaveLength(0);
  });

  it("delete wins over a concurrent edit (converges deleted)", async () => {
    newDevice("A");
    const id = await createClient({ name: "Contested", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    await sync("A");
    newDevice("B");
    await sync("B");
    const bId = rawOneOn<{ id: number }>("B", "SELECT id FROM clients")!.id;

    // A deletes; B edits — A syncs first so the tombstone lands before B pulls
    useDevice("A");
    await execute("DELETE FROM clients WHERE id=$1", [id]);
    useDevice("B");
    await execute("UPDATE clients SET name='B-edit' WHERE id=$1", [bId]);

    await sync("A");
    await sync("B");
    await sync("A");

    expect(rawOn("A", "SELECT id FROM clients")).toHaveLength(0);
    expect(rawOn("B", "SELECT id FROM clients")).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("a second immediate sync moves nothing", async () => {
    newDevice("A");
    await createClient({ name: "Once", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    await sync("A");
    const second = await sync("A");
    expect(second.pulled).toBe(0);
    expect(second.pushed).toBe(0);
    expect(second.deletedLocal).toBe(0);
    expect(second.deletedRemote).toBe(0);
  });
});

describe("seeded expense categories", () => {
  it("merge by name instead of doubling across devices", async () => {
    newDevice("A");
    const seededA = rawOn<{ n: number }>("A", "SELECT COUNT(*) n FROM expense_categories")[0]!.n;
    expect(seededA).toBeGreaterThanOrEqual(12);
    await sync("A");

    newDevice("B");
    await sync("B");

    // B keeps the same count (no duplicates) and adopts A's uuids
    const countB = rawOn<{ n: number }>("B", "SELECT COUNT(*) n FROM expense_categories")[0]!.n;
    expect(countB).toBe(seededA);

    const aUuids = new Set(rawOn<{ sync_uuid: string }>("A", "SELECT sync_uuid FROM expense_categories").map((r) => r.sync_uuid));
    const bUuids = rawOn<{ sync_uuid: string }>("B", "SELECT sync_uuid FROM expense_categories").map((r) => r.sync_uuid);
    for (const u of bUuids) expect(aUuids.has(u)).toBe(true);

    // remote also holds exactly one set
    expect(remoteRows("expense_categories")).toHaveLength(seededA);
  });
});

describe("milestone references across devices", () => {
  it("stageId and certificateId survive as uuids and re-resolve to B's local ids", async () => {
    newDevice("A");
    const clientId = await createClient({ name: "MS Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-2026-002", {
      name: "MS Project", clientId, country: null, city: null, manager: null, discipline: "MULTI",
      projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000,
      startDate: null, endDate: null, progressBp: 0, description: null,
    });
    const stageId = await createStage({
      projectId, name: "Concept", sortOrder: 0, startDate: null, endDate: null,
      status: "PLANNED", completionBp: 0, engineers: null, notes: null,
    });
    const contractId = await createContract({
      projectId, number: "C-MS", title: null, valueMinor: 1_000_000_00, vatBp: 0, retentionBp: 0,
      withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
      performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
      valuationMode: "MILESTONES",
      milestones: JSON.stringify([{ title: "Concept", percentBp: 10000, stageId, done: false }]),
      drawings: null, attachments: null, signedDate: null, notes: null,
    });
    // complete the stage → auto-draft the milestone certificate (sets certificateId)
    await updateStage(stageId, {
      projectId, name: "Concept", sortOrder: 0, startDate: null, endDate: null,
      status: "COMPLETED", completionBp: 10000, engineers: null, notes: null,
    });
    await reconcileMilestoneCertificates(contractId);

    const aMilestones = JSON.parse(rawOneOn<{ milestones: string }>("A", "SELECT milestones FROM contracts")!.milestones);
    expect(aMilestones[0].stageId).toBe(stageId);
    expect(aMilestones[0].certificateId).toBeGreaterThan(0);

    await sync("A");
    newDevice("B");
    await sync("B");

    // On B, the milestone refs must point at B's OWN local ids for the same rows
    const bStageId = rawOneOn<{ id: number }>("B", "SELECT id FROM project_stages WHERE name='Concept'")!.id;
    const bCertId = rawOneOn<{ id: number }>("B", "SELECT id FROM payment_certificates")!.id;
    const bMilestones = JSON.parse(rawOneOn<{ milestones: string }>("B", "SELECT milestones FROM contracts")!.milestones);
    expect(bMilestones[0].stageId).toBe(bStageId);
    expect(bMilestones[0].certificateId).toBe(bCertId);
  });
});

describe("time entries sync", () => {
  it("round-trip a time entry with person/project/stage FK translation", async () => {
    newDevice("A");
    const clientId = await createClient({ name: "T Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-2026-050", {
      name: "Timed Project", clientId, country: null, city: null, manager: null, discipline: "MULTI",
      projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000,
      startDate: null, endDate: null, progressBp: 0, description: null,
    });
    const stageId = await createStage({
      projectId, name: "Design", sortOrder: 0, startDate: null, endDate: null,
      status: "IN_PROGRESS", completionBp: 5000, engineers: null, notes: null,
    });
    const personId = (await execute(
      "INSERT INTO people (type, name, hourly_rate_minor, currency) VALUES ('EMPLOYEE','Eng A', 10000, 'EGP')",
    )).lastInsertId!;
    await execute(
      "INSERT INTO time_entries (person_id, project_id, stage_id, date, minutes, billable) VALUES ($1,$2,$3,'2026-07-19',90,1)",
      [personId, projectId, stageId],
    );

    await sync("A");
    newDevice("B");
    await sync("B");

    const bEntry = rawOneOn<{ minutes: number; person_id: number; project_id: number; stage_id: number }>(
      "B", "SELECT minutes, person_id, project_id, stage_id FROM time_entries",
    )!;
    const bPerson = rawOneOn<{ id: number }>("B", "SELECT id FROM people WHERE name='Eng A'")!.id;
    const bProject = rawOneOn<{ id: number }>("B", "SELECT id FROM projects WHERE code='PRJ-2026-050'")!.id;
    const bStage = rawOneOn<{ id: number }>("B", "SELECT id FROM project_stages WHERE name='Design'")!.id;
    expect(bEntry.minutes).toBe(90);
    expect(bEntry.person_id).toBe(bPerson);
    expect(bEntry.project_id).toBe(bProject);
    expect(bEntry.stage_id).toBe(bStage);
  });
});

describe("keyset cursor tie-break", () => {
  it("pulls every row when a batch boundary falls inside identical timestamps", async () => {
    // PULL_BATCH is 500; put 600 clients at the SAME updated_at so the naive
    // "updated_at > cursor" would skip the tail. The uuid tie-break must save it.
    newDevice("A");
    const N = 600;
    const ts = "2026-07-10T12:00:00.000Z";
    for (let i = 0; i < N; i++) {
      const id = await createClient({ name: `C${i}`, company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
      await execute("UPDATE clients SET updated_at=$1 WHERE id=$2", [ts, id]);
    }
    await sync("A");

    newDevice("B");
    await sync("B");
    expect(rawOn<{ n: number }>("B", "SELECT COUNT(*) n FROM clients")[0]!.n).toBe(N);
  });
});
