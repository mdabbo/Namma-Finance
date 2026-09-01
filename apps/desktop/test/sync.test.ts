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
  makeFakeClient,
} from "./sync-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createStage, updateStage } from "../src/repositories/stages";
import { reconcileMilestoneCertificates } from "../src/repositories/milestoneCertificates";
import { createAssignment, createPerson, createPersonPayment, deletePersonPayment } from "../src/repositories/people";
import { resolveSyncConflict } from "../src/repositories/syncConflicts";
import { createCertificate, nextCertificateSeq } from "../src/repositories/certificates";
import { createPayment } from "../src/repositories/payments";
import { createExpense } from "../src/repositories/expenses";

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
  it("surfaces same project code created offline and applies explicit KEEP_LOCAL", async () => {
    newDevice("A");
    const aClient = await createClient({ name: "Office A", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const aProject = await createProject("PRJ-2026-001", { name: "A Project", clientId: aClient, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    await createContract({ projectId: aProject, number: "CON-A", title: null, valueMinor: 50_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
    newDevice("B");
    const bClient = await createClient({ name: "Office B", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    await createProject("PRJ-2026-001", { name: "B Project", clientId: bClient, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    await sync("A");
    const report = await sync("B");
    expect(report.conflicts).toBe(1);
    expect(remoteRows("projects").filter((row) => row.deleted_at == null)).toHaveLength(1);
    const conflict = rawOneOn<{ id: number }>("B", "SELECT id FROM sync_conflicts WHERE table_name='projects' AND status='OPEN'")!;
    useDevice("B");
    await resolveSyncConflict(conflict.id, "KEEP_LOCAL", "Selected the locally verified project identity");
    await sync("B");
    const live = remoteRows("projects").filter((row) => row.deleted_at == null);
    expect(live).toHaveLength(2);
    expect(live.map((row) => row.name).sort()).toEqual(["A Project", "B Project"]);
    expect(new Set(live.map((row) => row.code)).size).toBe(2);
    expect(rawOn("B", "SELECT * FROM contracts WHERE number='CON-A'")).toHaveLength(1);
    expect(rawOn("B", "SELECT * FROM audit_logs WHERE action='NUMBER_COLLISION_RENUMBER'")).toHaveLength(1);
  });
  it("preserves concurrent contract edits and requires an audited resolution", async () => {
    newDevice("A");
    const clientId = await createClient({ name: "Conflict Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-CONFLICT", { name: "Conflict Project", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: "C-CONFLICT", title: "Common", valueMinor: 1_000_000, vatBp: 1400, retentionBp: 500, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
    await sync("A");
    newDevice("B");
    await sync("B");

    useDevice("A");
    await execute("UPDATE contracts SET title='Device A' WHERE id=$1", [contractId]);
    await stamp("contracts", contractId, "2099-01-02T00:00:00.000Z");
    await sync("A");

    useDevice("B");
    const b = rawOneOn<{ id: number }>("B", "SELECT id FROM contracts")!;
    await execute("UPDATE contracts SET title='Device B' WHERE id=$1", [b.id]);
    await stamp("contracts", b.id, "2099-01-03T00:00:00.000Z");
    const report = await sync("B");
    expect(report.conflicts).toBe(1);
    expect(rawOneOn<{ title: string }>("B", "SELECT title FROM contracts")!.title).toBe("Device B");
    const conflict = rawOneOn<{ id: number; status: string }>("B", "SELECT id,status FROM sync_conflicts")!;
    expect(conflict.status).toBe("OPEN");

    await resolveSyncConflict(conflict.id, "KEEP_REMOTE", "Finance manager selected the server version");
    await sync("B");
    expect(rawOneOn<{ title: string }>("B", "SELECT title FROM contracts")!.title).toBe("Device A");
    expect(rawOn("B", "SELECT * FROM audit_logs WHERE action='SYNC_CONFLICT_RESOLVED'")).toHaveLength(1);

    // A remote clock ahead of this device must not defeat KEEP_LOCAL.
    useDevice("B");
    await execute("UPDATE contracts SET title='Device B kept' WHERE id=$1", [b.id]);
    await stamp("contracts", b.id, "2099-01-04T00:00:00.000Z");
    useDevice("A");
    await execute("UPDATE contracts SET title='Device A future' WHERE id=$1", [contractId]);
    await stamp("contracts", contractId, "2099-01-06T00:00:00.000Z");
    await sync("A");
    await sync("B");
    const second = rawOneOn<{ id: number }>("B", "SELECT id FROM sync_conflicts WHERE status='OPEN'")!;
    useDevice("B");
    await resolveSyncConflict(second.id, "KEEP_LOCAL", "Approved this device's reviewed contract");
    await sync("B");
    expect(remoteRows("contracts")[0]!.title).toBe("Device B kept");
    const audit = rawOneOn<{ before_json: string }>("B", "SELECT before_json FROM audit_logs WHERE action='SYNC_CONFLICT_RESOLVED' ORDER BY id DESC")!;
    expect(audit.before_json).not.toContain("Device B kept");
  });

  it("detects a duplicate allocation and resolves KEEP_LOCAL without duplicating money", async () => {
    newDevice("A");
    const clientId = await createClient({ name: "Allocation Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-ALLOC-CONFLICT", { name: "Allocation Project", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: "C-ALLOC", title: null, valueMinor: 100_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
    const certificateId = await createCertificate(await nextCertificateSeq(contractId), { contractId, number: "PC-ALLOC", date: "2026-07-01", submissionDate: "2026-07-01", dueDateOverride: null, description: null, grossMinor: 10_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    await createPayment({ contractId, kind: "CERTIFICATE", number: "PAY-ALLOC", date: "2026-07-02", amountMinor: 10_000, method: "CASH", bank: null, reference: null, notes: null }, [{ certificateId, amountMinor: 10_000 }]);
    await sync("A");
    newDevice("B");
    await sync("B");
    const original = remoteRows("payment_certificate_allocations")[0]!;
    await makeFakeClient().from("payment_certificate_allocations").upsert([{ ...original, uuid: "99999999-9999-4999-8999-999999999999", updated_at: "2099-02-01T00:00:00.000Z" }], { onConflict: "uuid" });
    const report = await sync("B");
    expect(report.conflicts).toBe(1);
    expect(rawOn("B", "SELECT * FROM payment_certificate_allocations")).toHaveLength(1);
    const conflict = rawOneOn<{ id: number }>("B", "SELECT id FROM sync_conflicts WHERE conflict_kind='DUPLICATE_RECORD'")!;
    useDevice("B");
    await resolveSyncConflict(conflict.id, "KEEP_LOCAL", "Duplicate allocation rejected after evidence review");
    await sync("B");
    expect(rawOn("B", "SELECT * FROM payment_certificate_allocations")).toHaveLength(1);
    expect(remoteRows("payment_certificate_allocations").find((row) => row.uuid === "99999999-9999-4999-8999-999999999999")?.deleted_at).toBeTruthy();
  });
  it("preserves person-payment and expense reversal links even when reversals arrive first", async () => {
    newDevice("A");
    const clientId = await createClient({ name: "Reversal Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-REV-SYNC", { name: "Reversal Project", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    // A person payment cannot exceed earned-and-unpaid value, so the client
    // certificate that releases the fee is collected first.
    const revContractId = await createContract({ projectId, number: "C-REV-SYNC", title: null, valueMinor: 50_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
    const revCertificateId = await createCertificate(await nextCertificateSeq(revContractId), { contractId: revContractId, number: "PC-REV-SYNC", date: "2026-07-01", submissionDate: "2026-07-01", dueDateOverride: null, description: null, grossMinor: 50_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    await createPayment({ contractId: revContractId, kind: "CERTIFICATE", number: "PAY-REV-SYNC", date: "2026-07-02", amountMinor: 50_000, method: "CASH", bank: null, reference: null, notes: null }, [{ certificateId: revCertificateId, amountMinor: 50_000 }]);
    const personId = await createPerson({ type: "FREELANCER", name: "Reversal Person", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const assignmentId = await createAssignment({ personId, projectId, agreedMinor: 50_000, currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null });
    const paymentId = await createPersonPayment({ assignmentId, date: "2026-07-21", amountMinor: 10_000, note: "sync reversal" });
    await deletePersonPayment(paymentId);
    await sync("A");

    for (const table of ["person_payments", "expenses"]) {
      const rows = remoteRows(table);
      const reversal = rows.find((row) => row.reversal_of_id != null)!;
      const original = rows.find((row) => row.uuid === reversal.reversal_of_id)!;
      reversal.updated_at = "2099-01-01T00:00:00.000Z";
      original.updated_at = "2099-01-02T00:00:00.000Z";
    }

    newDevice("B");
    await sync("B");

    const bPaymentReversal = rawOneOn<{ reversal_of_id: number }>("B", "SELECT reversal_of_id FROM person_payments WHERE reversal_of_id IS NOT NULL")!;
    const bExpenseReversal = rawOneOn<{ reversal_of_id: number }>("B", "SELECT reversal_of_id FROM expenses WHERE reversal_of_id IS NOT NULL")!;
    expect(rawOn("B", `SELECT id FROM person_payments WHERE id=${bPaymentReversal.reversal_of_id}`)).toHaveLength(1);
    expect(rawOn("B", `SELECT id FROM expenses WHERE id=${bExpenseReversal.reversal_of_id}`)).toHaveLength(1);
  });

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
    const pulledAudit = rawOn<{ entity_type: string; source: string }>("B", "SELECT entity_type,source FROM audit_logs WHERE entity_type IN ('project','contract')");
    expect(pulledAudit.length).toBeGreaterThanOrEqual(2);
    expect(pulledAudit.every((row) => row.source === "SYNC")).toBe(true);
  });

  it("syncs portable document metadata without leaking a device cache path", async () => {
    newDevice("A");
    const clientId=await createClient({name:"Docs Client",company:null,address:null,phone:null,email:null,taxNumber:null,contacts:null,notes:null});
    const projectId=await createProject("PRJ-DOC-SYNC",{name:"Docs",clientId,country:null,city:null,manager:null,discipline:"MULTI",projectType:null,status:"ACTIVE",currency:"EGP",fxRateMicro:1_000_000,startDate:null,endDate:null,progressBp:0,description:null});
    await execute(`INSERT INTO documents(project_id,category,title,document_uuid,original_filename,extension,mime_type,size_bytes,sha256,storage_provider,cloud_storage_key,local_cache_path,version_number,is_available_offline)
      VALUES($1,'DRAWING','Floor plan','11111111-1111-4111-8111-111111111111','floor.dwg','dwg','image/vnd.dwg',1234,$2,'SUPABASE','user/doc/v1/floor.dwg','C:/Device-A/private/floor.dwg',1,1)`,[projectId,"a".repeat(64)]);
    await sync("A");
    const remote=remoteRows("documents")[0]!;
    expect(remote).not.toHaveProperty("path");
    expect(remote).not.toHaveProperty("local_cache_path");
    expect(remote).not.toHaveProperty("is_available_offline");

    newDevice("B");
    await sync("B");
    expect(rawOneOn("B","SELECT document_uuid,cloud_storage_key,local_cache_path,is_available_offline FROM documents")).toEqual({
      document_uuid:"11111111-1111-4111-8111-111111111111",cloud_storage_key:"user/doc/v1/floor.dwg",local_cache_path:null,is_available_offline:0,
    });
    expect(rawOn("B","SELECT * FROM document_cache")).toEqual([]);
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

describe("archives", () => {
  it("propagate to the other device without a tombstone", async () => {
    newDevice("A");
    const id = await createClient({ name: "ToDelete", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    await sync("A");
    newDevice("B");
    await sync("B");
    expect(rawOn("B", "SELECT id FROM clients")).toHaveLength(1);

    useDevice("A");
    await execute("UPDATE clients SET archived_at='2099-07-04T00:00:00.000Z', archive_reason='test archive', updated_at='2099-07-04T00:00:00.000Z' WHERE id=$1", [id]);
    await sync("A");
    await sync("B");

    expect(rawOneOn<{ archived_at: string }>("B", "SELECT archived_at FROM clients")?.archived_at).toBeTruthy();
    expect(rawOn("B", "SELECT id FROM sync_tombstones")).toHaveLength(0);

    // a further round must not resurrect the row on either side
    await sync("A");
    await sync("B");
    expect(rawOneOn<{ archived_at: string }>("A", "SELECT archived_at FROM clients")?.archived_at).toBeTruthy();
    expect(rawOneOn<{ archived_at: string }>("B", "SELECT archived_at FROM clients")?.archived_at).toBeTruthy();
  });

  it("a later archive wins over an earlier concurrent edit", async () => {
    newDevice("A");
    const id = await createClient({ name: "Contested", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    await sync("A");
    newDevice("B");
    await sync("B");
    const bId = rawOneOn<{ id: number }>("B", "SELECT id FROM clients")!.id;

    // A deletes; B edits — A syncs first so the tombstone lands before B pulls
    useDevice("A");
    await execute("UPDATE clients SET archived_at='2099-07-05T00:00:00.000Z', archive_reason='test archive', updated_at='2099-07-05T00:00:00.000Z' WHERE id=$1", [id]);
    useDevice("B");
    await execute("UPDATE clients SET name='B-edit', updated_at='2099-07-04T00:00:00.000Z' WHERE id=$1", [bId]);

    await sync("A");
    await sync("B");
    await sync("A");

    expect(rawOneOn<{ archived_at: string }>("A", "SELECT archived_at FROM clients")?.archived_at).toBeTruthy();
    expect(rawOneOn<{ archived_at: string }>("B", "SELECT archived_at FROM clients")?.archived_at).toBeTruthy();
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
      milestones: JSON.stringify([{ title: "Concept", percentBp: 10000, stageId, done: false, extension: { source: "legacy", version: 2 } }]),
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
    expect(bMilestones[0].extension).toEqual({ source: "legacy", version: 2 });
  });
});

describe("domain-aware certificate sync", () => {
  async function syncedApprovedCertificate() {
    newDevice("A");
    const clientId = await createClient({ name: "Certificate Sync Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-CERT-SYNC", { name: "Certificate Sync", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: "C-CERT-SYNC", title: null, valueMinor: 100_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
    await createCertificate(await nextCertificateSeq(contractId), { contractId, number: "PC-CERT-SYNC", date: "2026-07-01", submissionDate: "2026-07-01", dueDateOverride: null, description: null, grossMinor: 10_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    await sync("A");
    newDevice("B");
    await sync("B");
    return { contractId };
  }

  it("does not trust a remote PAID certificate status without local payment evidence", async () => {
    await syncedApprovedCertificate();
    const remote = remoteRows("payment_certificates")[0]!;
    remote.status = "PAID";
    remote.updated_at = "2099-03-01T00:00:00.000Z";

    await sync("B");

    expect(rawOneOn<{ status: string }>("B", "SELECT status FROM payment_certificates")!.status).toBe("APPROVED");
  });

  it("rejects remote financial edits to an immutable certificate", async () => {
    await syncedApprovedCertificate();
    const remote = remoteRows("payment_certificates")[0]!;
    remote.gross_minor = 20_000;
    remote.updated_at = "2099-03-02T00:00:00.000Z";

    useDevice("B");
    const report = await runSync();

    expect(report.ok).toBe(false);
    expect(report.error).toContain("CERTIFICATE_FINANCIALS_IMMUTABLE");
    expect(rawOneOn<{ gross_minor: number }>("B", "SELECT gross_minor FROM payment_certificates")!.gross_minor).toBe(10_000);
  });
});

describe("domain-aware payment and allocation sync", () => {
  async function paymentSyncFixture(prefix = "PAY-SYNC") {
    newDevice("A");
    const clientId = await createClient({ name: `${prefix} Client`, company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject(`PRJ-${prefix}`, { name: `${prefix} Project`, clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: `C-${prefix}`, title: null, valueMinor: 100_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
    const certificateId = await createCertificate(await nextCertificateSeq(contractId), { contractId, number: `PC-${prefix}`, date: "2026-07-01", submissionDate: "2026-07-01", dueDateOverride: null, description: null, grossMinor: 10_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    await sync("A");
    newDevice("B");
    await sync("B");
    return { contractId, certificateId };
  }

  it("settles a certificate only when synced payment evidence fully covers it", async () => {
    const { contractId, certificateId } = await paymentSyncFixture("PAY-FULL");
    useDevice("A");
    await createPayment({ contractId, kind: "CERTIFICATE", number: "PAY-FULL", date: "2026-07-02", amountMinor: 10_000, method: "CASH", bank: null, reference: null, notes: null }, [{ certificateId, amountMinor: 10_000 }]);
    await sync("A");
    await sync("B");
    expect(rawOneOn<{ status: string }>("B", "SELECT status FROM payment_certificates")!.status).toBe("PAID");
  });

  it("keeps a partially allocated synced payment from settling a certificate", async () => {
    const { contractId, certificateId } = await paymentSyncFixture("PAY-PART");
    useDevice("A");
    await createPayment({ contractId, kind: "CERTIFICATE", number: "PAY-PART", date: "2026-07-02", amountMinor: 5_000, method: "CASH", bank: null, reference: null, notes: null }, [{ certificateId, amountMinor: 5_000 }]);
    await sync("A");
    await sync("B");
    expect(rawOneOn<{ status: string }>("B", "SELECT status FROM payment_certificates")!.status).toBe("APPROVED");
  });

  it("reopens a synced certificate after payment reduction or void", async () => {
    const { contractId, certificateId } = await paymentSyncFixture("PAY-REOPEN");
    useDevice("A");
    const paymentId = await createPayment({ contractId, kind: "CERTIFICATE", number: "PAY-REOPEN", date: "2026-07-02", amountMinor: 10_000, method: "CASH", bank: null, reference: null, notes: null }, [{ certificateId, amountMinor: 10_000 }]);
    await sync("A");
    await sync("B");
    expect(rawOneOn<{ status: string }>("B", "SELECT status FROM payment_certificates")!.status).toBe("PAID");

    useDevice("A");
    await import("../src/repositories/payments").then(({ updatePayment }) =>
      updatePayment(paymentId, { contractId, kind: "CERTIFICATE", number: "PAY-REOPEN", date: "2026-07-02", amountMinor: 5_000, method: "CASH", bank: null, reference: null, notes: null }, [{ certificateId, amountMinor: 5_000 }]),
    );
    await sync("A");
    await sync("B");
    expect(rawOneOn<{ status: string }>("B", "SELECT status FROM payment_certificates")!.status).toBe("APPROVED");

    useDevice("A");
    await import("../src/repositories/payments").then(({ deletePayment }) => deletePayment(paymentId, "sync void"));
    await sync("A");
    await sync("B");
    expect(rawOneOn<{ status: string }>("B", "SELECT status FROM payment_certificates")!.status).toBe("APPROVED");
  });

  it("rejects a synced allocation above the payment amount without changing local evidence", async () => {
    const first = await paymentSyncFixture("PAY-BAD-A");
    useDevice("A");
    await createPayment({ contractId: first.contractId, kind: "CERTIFICATE", number: "PAY-BAD", date: "2026-07-02", amountMinor: 4_000, method: "CASH", bank: null, reference: null, notes: null }, []);
    await sync("A");
    await sync("B");
    const paymentUuid = remoteRows("payments").find((row) => row.number === "PAY-BAD")!.uuid;
    const firstCertUuid = remoteRows("payment_certificates").find((row) => row.number === "PC-PAY-BAD-A")!.uuid;

    await makeFakeClient().from("payment_certificate_allocations").upsert([{ uuid: "88888888-8888-4888-8888-888888888881", payment_id: paymentUuid, certificate_id: firstCertUuid, amount_minor: 4_001, updated_at: "2099-04-01T00:00:00.000Z", deleted_at: null }], { onConflict: "uuid" });
    useDevice("B");
    const report = await runSync();
    expect(report.ok).toBe(false);
    expect(report.error).toContain("ALLOCATIONS_EXCEED_PAYMENT");
    expect(rawOn("B", "SELECT * FROM payment_certificate_allocations")).toHaveLength(0);
  });

  it("rejects a synced allocation above certificate capacity", async () => {
    const first = await paymentSyncFixture("PAY-BAD-B");
    useDevice("A");
    await createPayment({ contractId: first.contractId, kind: "CERTIFICATE", number: "PAY-BAD-CAP", date: "2026-07-02", amountMinor: 20_000, method: "CASH", bank: null, reference: null, notes: null }, []);
    await sync("A");
    await sync("B");
    const paymentUuid = remoteRows("payments").find((row) => row.number === "PAY-BAD-CAP")!.uuid;
    const certUuid = remoteRows("payment_certificates").find((row) => row.number === "PC-PAY-BAD-B")!.uuid;

    await makeFakeClient().from("payment_certificate_allocations").upsert([{ uuid: "88888888-8888-4888-8888-888888888882", payment_id: paymentUuid, certificate_id: certUuid, amount_minor: 10_001, updated_at: "2099-04-02T00:00:00.000Z", deleted_at: null }], { onConflict: "uuid" });
    useDevice("B");
    const report = await runSync();
    expect(report.ok).toBe(false);
    expect(report.error).toContain("ALLOCATION_EXCEEDS_CERTIFICATE_UNPAID");
    expect(rawOn("B", "SELECT * FROM payment_certificate_allocations")).toHaveLength(0);
  });

  it("rejects a cross-contract synced allocation", async () => {
    newDevice("A");
    const clientId = await createClient({ name: "Cross Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectA = await createProject("PRJ-CROSS-A", { name: "Cross A", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const projectB = await createProject("PRJ-CROSS-B", { name: "Cross B", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractA = await createContract({ projectId: projectA, number: "C-CROSS-A", title: null, valueMinor: 10_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
    const contractB = await createContract({ projectId: projectB, number: "C-CROSS-B", title: null, valueMinor: 10_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
    const certificateA = await createCertificate(await nextCertificateSeq(contractA), { contractId: contractA, number: "PC-CROSS-A", date: "2026-07-01", submissionDate: "2026-07-01", dueDateOverride: null, description: null, grossMinor: 10_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    await createPayment({ contractId: contractB, kind: "CERTIFICATE", number: "PAY-CROSS", date: "2026-07-02", amountMinor: 1_000, method: "CASH", bank: null, reference: null, notes: null }, []);
    await sync("A");
    newDevice("B");
    await sync("B");
    const paymentUuid = remoteRows("payments").find((row) => row.number === "PAY-CROSS")!.uuid;
    const certificateUuid = remoteRows("payment_certificates").find((row) => row.number === "PC-CROSS-A")!.uuid;
    expect(certificateA).toBeGreaterThan(0);

    await makeFakeClient().from("payment_certificate_allocations").upsert([{ uuid: "88888888-8888-4888-8888-888888888883", payment_id: paymentUuid, certificate_id: certificateUuid, amount_minor: 1_000, updated_at: "2099-04-03T00:00:00.000Z", deleted_at: null }], { onConflict: "uuid" });
    useDevice("B");
    const report = await runSync();
    expect(report.ok).toBe(false);
    expect(report.error).toContain("ALLOCATION_CONTRACT_MISMATCH");
    expect(rawOn("B", "SELECT * FROM payment_certificate_allocations")).toHaveLength(0);
  });

  it("rejects a synced payment for an archived contract", async () => {
    await paymentSyncFixture("PAY-ARCHIVE");
    const contractUuid = remoteRows("contracts")[0]!.uuid;
    useDevice("B");
    await execute("UPDATE contracts SET archived_at='2099-05-01T00:00:00.000Z' WHERE number='C-PAY-ARCHIVE'");
    await makeFakeClient().from("payments").upsert([{ uuid: "77777777-7777-4777-8777-777777777777", contract_id: contractUuid, kind: "CERTIFICATE", number: "PAY-ARCHIVED", date: "2026-07-02", amount_minor: 1_000, method: "CASH", bank: null, reference: null, notes: null, app_deleted_at: null, created_at: "2099-05-02T00:00:00.000Z", voided_at: null, voided_by: null, void_reason: null, reversal_of_id: null, updated_at: "2099-05-02T00:00:00.000Z", deleted_at: null }], { onConflict: "uuid" });
    const report = await runSync();
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/CONTRACT_NOT_FOUND|ARCHIVED_CONTRACT_IS_READ_ONLY/);
    expect(rawOn("B", "SELECT id FROM payments WHERE number='PAY-ARCHIVED'")).toHaveLength(0);
  });
});

describe("domain-aware assignment and person-payment sync", () => {
  async function teamSyncFixture(prefix = "TEAM-SYNC") {
    newDevice("A");
    const clientId = await createClient({ name: `${prefix} Client`, company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject(`PRJ-${prefix}`, { name: `${prefix} Project`, clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: `C-${prefix}`, title: null, valueMinor: 100_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
    const firstCertificateId = await createCertificate(await nextCertificateSeq(contractId), { contractId, number: `PC-${prefix}-1`, date: "2026-07-01", submissionDate: "2026-07-01", dueDateOverride: null, description: null, grossMinor: 40_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    const secondCertificateId = await createCertificate(await nextCertificateSeq(contractId), { contractId, number: `PC-${prefix}-2`, date: "2026-07-11", submissionDate: "2026-07-11", dueDateOverride: null, description: null, grossMinor: 60_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    await createPayment({ contractId, kind: "CERTIFICATE", number: `PAY-${prefix}-1`, date: "2026-07-02", amountMinor: 40_000, method: "CASH", bank: null, reference: null, notes: null }, [{ certificateId: firstCertificateId, amountMinor: 40_000 }]);
    const personId = await createPerson({ type: "FREELANCER", name: `${prefix} Person`, specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    await createAssignment({ personId, projectId, agreedMinor: 100_000, currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null });
    await sync("A");
    newDevice("B");
    await sync("B");
    return { contractId, secondCertificateId };
  }

  it("derives synced cancellation earnings from payment evidence and ignores later collections", async () => {
    const { contractId, secondCertificateId } = await teamSyncFixture("TEAM-CANCEL");
    const assignment = remoteRows("project_assignments")[0]!;
    Object.assign(assignment, {
      lifecycle_status: "CANCELLED",
      cancelled_at: "2026-07-10T00:00:00.000Z",
      cancellation_reason: "Remote cancellation",
      earned_minor_at_cancellation: 40_000,
      updated_at: "2099-06-01T00:00:00.000Z",
    });
    useDevice("A");
    await createPayment({ contractId, kind: "CERTIFICATE", number: "PAY-TEAM-CANCEL-LATE", date: "2026-07-11", amountMinor: 60_000, method: "CASH", bank: null, reference: null, notes: null }, [{ certificateId: secondCertificateId, amountMinor: 60_000 }]);
    await sync("A");

    await sync("B");

    const pulled = rawOneOn<{ lifecycle_status: string; earned_minor_at_cancellation: number }>(
      "B",
      "SELECT lifecycle_status,earned_minor_at_cancellation FROM project_assignments",
    )!;
    expect(pulled.lifecycle_status).toBe("CANCELLED");
    expect(pulled.earned_minor_at_cancellation).toBe(40_000);
  });

  it("rejects a synced cancellation with an unearned frozen amount", async () => {
    await teamSyncFixture("TEAM-BAD-CANCEL");
    const assignment = remoteRows("project_assignments")[0]!;
    Object.assign(assignment, {
      lifecycle_status: "CANCELLED",
      cancelled_at: "2026-07-10T00:00:00.000Z",
      cancellation_reason: "Inflated",
      earned_minor_at_cancellation: 99_999,
      updated_at: "2099-06-02T00:00:00.000Z",
    });

    useDevice("B");
    const report = await runSync();

    expect(report.ok).toBe(false);
    expect(report.error).toContain("SYNC_CANCELLATION_EARNED_MISMATCH");
    expect(rawOneOn<{ lifecycle_status: string }>("B", "SELECT lifecycle_status FROM project_assignments")!.lifecycle_status).toBe("ACTIVE");
  });

  it("creates the linked expense when a valid person payment is pulled", async () => {
    await teamSyncFixture("TEAM-PAY");
    const assignmentUuid = remoteRows("project_assignments")[0]!.uuid;
    await makeFakeClient().from("person_payments").upsert([{
      uuid: "66666666-6666-4666-8666-666666666661",
      assignment_id: assignmentUuid,
      date: "2026-07-05",
      amount_minor: 10_000,
      note: "remote team payout",
      created_at: "2099-06-03T00:00:00.000Z",
      voided_at: null,
      voided_by: null,
      void_reason: null,
      reversal_of_id: null,
      updated_at: "2099-06-03T00:00:00.000Z",
      deleted_at: null,
    }], { onConflict: "uuid" });

    await sync("B");

    const payment = rawOneOn<{ id: number; amount_minor: number }>("B", "SELECT id,amount_minor FROM person_payments WHERE voided_at IS NULL")!;
    expect(payment.amount_minor).toBe(10_000);
    expect(rawOn("B", `SELECT id FROM expenses WHERE person_payment_id=${payment.id} AND voided_at IS NULL`)).toHaveLength(1);
  });

  it("rejects a synced person payment above lifecycle-aware due", async () => {
    await teamSyncFixture("TEAM-OVERPAY");
    const assignmentUuid = remoteRows("project_assignments")[0]!.uuid;
    await makeFakeClient().from("person_payments").upsert([{
      uuid: "66666666-6666-4666-8666-666666666662",
      assignment_id: assignmentUuid,
      date: "2026-07-05",
      amount_minor: 40_001,
      note: "too much",
      created_at: "2099-06-04T00:00:00.000Z",
      voided_at: null,
      voided_by: null,
      void_reason: null,
      reversal_of_id: null,
      updated_at: "2099-06-04T00:00:00.000Z",
      deleted_at: null,
    }], { onConflict: "uuid" });

    useDevice("B");
    const report = await runSync();

    expect(report.ok).toBe(false);
    expect(report.error).toContain("PERSON_PAYMENT_EXCEEDS_DUE");
    expect(rawOn("B", "SELECT id FROM person_payments")).toHaveLength(0);
    expect(rawOn("B", "SELECT id FROM expenses WHERE person_payment_id IS NOT NULL")).toHaveLength(0);
  });
});

describe("domain-aware expense and revision sync", () => {
  async function financialSyncFixture(prefix = "M5-SYNC") {
    newDevice("A");
    const clientId = await createClient({ name: `${prefix} Client`, company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject(`PRJ-${prefix}`, { name: `${prefix} Project`, clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: `C-${prefix}`, title: null, valueMinor: 100_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: "2026-07-01", notes: null });
    await sync("A");
    newDevice("B");
    await sync("B");
    return { projectId, contractId };
  }

  it("pulls and voids a standalone expense through the synced expense path", async () => {
    const { projectId } = await financialSyncFixture("EXPENSE");
    useDevice("A");
    const categoryId = rawOneOn<{ id: number }>("A", "SELECT id FROM expense_categories WHERE name_en='Travel'")!.id;
    const expenseId = await createExpense({ date: "2026-07-05", categoryId, description: "Site visit", projectId, supplier: "Driver", amountMinor: 2_500, currency: "EGP", fxRateMicro: 1_000_000, attachmentPath: null });
    await sync("A");
    await sync("B");

    expect(rawOneOn<{ amount_minor: number }>("B", "SELECT amount_minor FROM expenses WHERE description='Site visit'")!.amount_minor).toBe(2_500);

    useDevice("A");
    await execute("UPDATE expenses SET voided_at='2026-07-06T00:00:00.000Z', void_reason='Remote void' WHERE id=$1", [expenseId]);
    await sync("A");
    await sync("B");
    expect(rawOneOn<{ voided_at: string | null }>("B", "SELECT voided_at FROM expenses WHERE description='Site visit'")!.voided_at).toBeTruthy();
  });

  it("rejects an independently inserted linked expense", async () => {
    await financialSyncFixture("LINKED-EXPENSE");
    const categoryUuid = remoteRows("expense_categories").find((row) => row.name_en === "Freelancers")!.uuid;
    const projectUuid = remoteRows("projects")[0]!.uuid;
    await makeFakeClient().from("expenses").upsert([{
      uuid: "55555555-7777-4777-8777-555555555551",
      number: "EXP-SPOOF",
      date: "2026-07-05",
      category_id: categoryUuid,
      description: "Spoofed linked expense",
      project_id: projectUuid,
      supplier: "Someone",
      amount_minor: 1_000,
      currency: "EGP",
      fx_rate_micro: 1_000_000,
      person_payment_id: "55555555-7777-4777-8777-555555555552",
      created_at: "2099-07-01T00:00:00.000Z",
      archived_at: null,
      archived_by: null,
      archive_reason: null,
      voided_at: null,
      voided_by: null,
      void_reason: null,
      reversal_of_id: null,
      updated_at: "2099-07-01T00:00:00.000Z",
      deleted_at: null,
    }], { onConflict: "uuid" });

    useDevice("B");
    const report = await runSync();

    expect(report.ok).toBe(true);
    expect(rawOn("B", "SELECT id FROM expenses WHERE description='Spoofed linked expense'")).toHaveLength(0);
  });

  it("refuses to rewrite an approved synced contract revision", async () => {
    await financialSyncFixture("REV-IMMUTABLE");
    const revision = remoteRows("contract_revisions")[0]!;
    revision.vat_bp = 999;
    revision.updated_at = "2099-07-02T00:00:00.000Z";

    useDevice("B");
    const report = await runSync();

    expect(report.ok).toBe(false);
    expect(report.error).toContain("APPROVED_CONTRACT_REVISION_IMMUTABLE");
    expect(rawOneOn<{ vat_bp: number }>("B", "SELECT vat_bp FROM contract_revisions")!.vat_bp).toBe(0);
  });

  it("refuses to rewrite an approved synced variation order", async () => {
    const { contractId } = await financialSyncFixture("VO-IMMUTABLE");
    useDevice("A");
    await import("../src/repositories/contracts").then(({ updateContract }) =>
      updateContract(contractId, { projectId: 1, number: "C-VO-IMMUTABLE", title: null, valueMinor: 110_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: "2026-07-01", notes: null }, { effectiveDate: "2026-07-02", reason: "Approved VO" }),
    );
    await sync("A");
    await sync("B");
    const variation = remoteRows("variation_orders")[0]!;
    variation.value_delta_minor = 1;
    variation.updated_at = "2099-07-03T00:00:00.000Z";

    useDevice("B");
    const report = await runSync();

    expect(report.ok).toBe(false);
    expect(report.error).toContain("APPROVED_VARIATION_ORDER_IMMUTABLE");
    expect(rawOneOn<{ value_delta_minor: number }>("B", "SELECT value_delta_minor FROM variation_orders")!.value_delta_minor).toBe(10_000);
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
