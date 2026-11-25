import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two-device sync rig backs both the repositories and the sync engine, so
// a claim travels exactly as it will: filed in the cloud (as the phone does),
// pulled, decided on a desktop, pushed back, and pulled by another desktop.
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
import { execute, makeFakeClient, newDevice, rawOn, rawOneOn, remoteRows, resetRig, useDevice } from "./sync-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createPerson } from "../src/repositories/people";
import { acceptExpenseClaim, listExpenseClaims, pendingClaimCount, rejectExpenseClaim } from "../src/repositories/expenseClaims";

/**
 * Expense claims on the desktop (plan step F6): accept creates exactly one
 * numbered expense from the claim's own figures, reject records why, a decided
 * claim never changes, and the whole thing survives sync between two desktops
 * without doubling an expense or silently undoing a decision.
 */

const CLAIM = "c1a1c1a1-0000-4000-8000-000000000001";

async function sync(deviceId: string) {
  useDevice(deviceId);
  const report = await runSync();
  if (!report.ok) throw new Error(`sync(${deviceId}) failed: ${report.error}`);
  return report;
}

/** Device A with a person, a project and a category, all pushed to the cloud. */
async function office() {
  newDevice("A");
  const clientId = await createClient({ name: "Office", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject("PRJ-2026-001", { name: "Tower", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
  const personId = await createPerson({ type: "EMPLOYEE", name: "Omar", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
  await sync("A");
  const uuidOf = (table: string, id: number) => rawOneOn<{ sync_uuid: string }>("A", `SELECT sync_uuid FROM ${table} WHERE id=${id}`)!.sync_uuid;
  const categoryId = rawOneOn<{ id: number }>("A", "SELECT id FROM expense_categories ORDER BY id LIMIT 1")!.id;
  return { projectId, personId, categoryId, personUuid: uuidOf("people", personId), projectUuid: uuidOf("projects", projectId) };
}

/** A claim as the phone writes it into the cloud. */
async function phoneFiles(o: { personUuid: string; projectUuid: string }, overrides: Record<string, unknown> = {}) {
  await makeFakeClient().from("expense_claims").upsert([{
    uuid: CLAIM, person_id: o.personUuid, project_id: o.projectUuid, category_id: null, date: "2026-11-20",
    amount_minor: 15_000, currency: "EGP", description: "Printing the drawings", supplier: "Copy Centre",
    receipt_storage_key: null, receipt_sha256: null, submitted_at: "2026-11-20T09:00:00.000Z",
    decision: null, decided_at: null, decided_by: null, decision_reason: null,
    created_at: "2026-11-20 09:00:00", updated_at: "2026-11-20T09:00:00.000Z", deleted_at: null, ...overrides,
  }], { onConflict: "uuid" });
}

const localClaim = (device: string) => rawOneOn<Record<string, unknown>>(device, `SELECT * FROM expense_claims WHERE sync_uuid='${CLAIM}'`);
const remoteClaim = () => remoteRows("expense_claims").find((row) => row.uuid === CLAIM)!;
const expensesFor = (device: string) => rawOn<Record<string, unknown>>(device, `SELECT * FROM expenses WHERE sync_uuid='${CLAIM}'`);

beforeEach(() => resetRig());
afterEach(() => resetRig());

describe("a claim filed on the phone", () => {
  it("arrives on the desktop as a pending claim with its person and project", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    const claims = await listExpenseClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      personId: o.personId, personName: "Omar", projectId: o.projectId, projectCode: "PRJ-2026-001",
      amountMinor: 15_000, currency: "EGP", description: "Printing the drawings", decision: null, expenseId: null,
    });
    expect(await pendingClaimCount()).toBe(1);
  });
});

describe("accepting a claim", () => {
  it("creates one numbered expense from the claim's figures and records the decision", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    const claimId = (await listExpenseClaims())[0]!.id;
    const expenseId = await acceptExpenseClaim({ claimId, categoryId: o.categoryId, projectId: o.projectId, fxRateMicro: 1_000_000 });

    const [expense] = expensesFor("A");
    expect(expense).toMatchObject({
      id: expenseId, number: "EXP-2026-0001", date: "2026-11-20", category_id: o.categoryId, project_id: o.projectId,
      description: "Printing the drawings", supplier: "Copy Centre", amount_minor: 15_000, currency: "EGP", fx_rate_micro: 1_000_000,
    });
    const claim = (await listExpenseClaims())[0]!;
    expect(claim).toMatchObject({ decision: "ACCEPTED", decidedBy: "DESKTOP", categoryId: o.categoryId, expenseId, expenseNumber: "EXP-2026-0001" });
    expect(await pendingClaimCount()).toBe(0);
  });

  it("refuses a second decision and leaves one expense", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    const claimId = (await listExpenseClaims())[0]!.id;
    await acceptExpenseClaim({ claimId, categoryId: o.categoryId, projectId: null, fxRateMicro: 1_000_000 });
    await expect(acceptExpenseClaim({ claimId, categoryId: o.categoryId, projectId: null, fxRateMicro: 1_000_000 })).rejects.toThrow("CLAIM_ALREADY_DECIDED");
    await expect(rejectExpenseClaim({ claimId, reason: "x" })).rejects.toThrow("CLAIM_ALREADY_DECIDED");
    expect(expensesFor("A")).toHaveLength(1);
  });

  it("keeps an EGP claim at a rate of 1 and needs a category that exists", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    const claimId = (await listExpenseClaims())[0]!.id;
    await expect(acceptExpenseClaim({ claimId, categoryId: o.categoryId, projectId: null, fxRateMicro: 12_800_000 })).rejects.toThrow("CLAIM_EGP_RATE_MUST_BE_ONE");
    await expect(acceptExpenseClaim({ claimId, categoryId: 99_999, projectId: null, fxRateMicro: 1_000_000 })).rejects.toThrow("CLAIM_CATEGORY_NOT_FOUND");
    expect(expensesFor("A")).toHaveLength(0);
    expect(localClaim("A")!.decision).toBeNull();
  });

  it("takes the office's rate for a foreign-currency claim", async () => {
    const o = await office();
    await phoneFiles(o, { currency: "SAR" });
    await sync("A");
    const claimId = (await listExpenseClaims())[0]!.id;
    await acceptExpenseClaim({ claimId, categoryId: o.categoryId, projectId: null, fxRateMicro: 12_850_000 });
    expect(expensesFor("A")[0]).toMatchObject({ currency: "SAR", fx_rate_micro: 12_850_000 });
  });
});

describe("a claim another desktop already turned into an expense", () => {
  it("is not accepted again, so the expense is never doubled", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    await execute(
      "INSERT INTO expenses(number,date,category_id,description,amount_minor,currency,fx_rate_micro,sync_uuid) VALUES('EXP-2026-0009','2026-11-20',$1,'From the other PC',15000,'EGP',1000000,$2)",
      [o.categoryId, CLAIM],
    );
    const claimId = (await listExpenseClaims())[0]!.id;
    await expect(acceptExpenseClaim({ claimId, categoryId: o.categoryId, projectId: null, fxRateMicro: 1_000_000 })).rejects.toThrow("CLAIM_EXPENSE_EXISTS");
    expect(expensesFor("A")).toHaveLength(1);
    expect(localClaim("A")!.decision).toBeNull();
  });
});

describe("the claims list", () => {
  it("puts claims waiting for a decision before decided ones", async () => {
    const o = await office();
    await phoneFiles(o);
    await makeFakeClient().from("expense_claims").upsert([{
      uuid: "c1a1c1a1-0000-4000-8000-000000000002", person_id: o.personUuid, project_id: null, category_id: null, date: "2026-11-01",
      amount_minor: 500, currency: "EGP", description: "Older claim", supplier: null, receipt_storage_key: null, receipt_sha256: null,
      submitted_at: "2026-11-01T09:00:00.000Z", decision: null, decided_at: null, decided_by: null, decision_reason: null,
      created_at: null, updated_at: "2026-11-01T09:00:00.000Z", deleted_at: null,
    }], { onConflict: "uuid" });
    await sync("A");
    const older = (await listExpenseClaims()).find((c) => c.description === "Older claim")!;
    await rejectExpenseClaim({ claimId: older.id, reason: "Duplicate" });
    expect((await listExpenseClaims()).map((c) => [c.description, c.decision])).toEqual([
      ["Printing the drawings", null],
      ["Older claim", "REJECTED"],
    ]);
  });
});

describe("rejecting a claim", () => {
  it("needs a reason, records it, and creates no expense", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    const claimId = (await listExpenseClaims())[0]!.id;
    await expect(rejectExpenseClaim({ claimId, reason: "  " })).rejects.toThrow("CLAIM_REJECTION_REASON_REQUIRED");
    await rejectExpenseClaim({ claimId, reason: " Personal purchase " });
    expect((await listExpenseClaims())[0]).toMatchObject({ decision: "REJECTED", decisionReason: "Personal purchase", expenseId: null });
    expect(expensesFor("A")).toHaveLength(0);
  });
});

describe("through sync", () => {
  it("sends the decision and the expense to the cloud, and a second desktop gets one of each", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    const claimId = (await listExpenseClaims())[0]!.id;
    await acceptExpenseClaim({ claimId, categoryId: o.categoryId, projectId: o.projectId, fxRateMicro: 1_000_000 });
    await sync("A");

    expect(remoteClaim()).toMatchObject({ decision: "ACCEPTED", decided_by: "DESKTOP" });
    const remoteExpenses = remoteRows("expenses").filter((row) => row.uuid === CLAIM);
    expect(remoteExpenses).toHaveLength(1);
    expect(remoteExpenses[0]).toMatchObject({ amount_minor: 15_000, number: "EXP-2026-0001" });

    newDevice("B");
    await sync("B");
    expect(localClaim("B")).toMatchObject({ decision: "ACCEPTED" });
    expect(expensesFor("B")).toHaveLength(1);
    // B sees the claim as decided, so it cannot accept it a second time.
    const bClaim = rawOneOn<{ id: number }>("B", `SELECT id FROM expense_claims WHERE sync_uuid='${CLAIM}'`)!;
    useDevice("B");
    await expect(acceptExpenseClaim({ claimId: bClaim.id, categoryId: o.categoryId, projectId: null, fxRateMicro: 1_000_000 })).rejects.toThrow("CLAIM_ALREADY_DECIDED");
  });

  it("surfaces a phone edit that raced a decision, instead of silently undoing it", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    const claimId = (await listExpenseClaims())[0]!.id;
    await acceptExpenseClaim({ claimId, categoryId: o.categoryId, projectId: null, fxRateMicro: 1_000_000 });
    // Before A pushes its decision, the phone changes the amount in the cloud.
    await phoneFiles(o, { amount_minor: 99_000, updated_at: "2099-01-01T00:00:00.000Z" });
    await sync("A");
    // The local decision and the expense stand ...
    expect(localClaim("A")).toMatchObject({ decision: "ACCEPTED", amount_minor: 15_000 });
    expect(expensesFor("A")).toHaveLength(1);
    // ... and the disagreement waits for the office to resolve.
    const conflict = rawOneOn<{ conflict_kind: string }>("A", "SELECT conflict_kind FROM sync_conflicts WHERE table_name='expense_claims' AND status='OPEN'");
    expect(conflict?.conflict_kind).toBe("CONCURRENT_EDIT");
  });

  it("removes a pending claim the phone withdrew", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    await phoneFiles(o, { deleted_at: "2026-11-21T00:00:00.000Z", updated_at: "2026-11-21T00:00:00.000Z" });
    await sync("A");
    expect(localClaim("A")).toBeUndefined();
    expect(await pendingClaimCount()).toBe(0);
  });

  it("never lets an edit change a decided claim on the desktop", async () => {
    const o = await office();
    await phoneFiles(o);
    await sync("A");
    const claimId = (await listExpenseClaims())[0]!.id;
    await rejectExpenseClaim({ claimId, reason: "Duplicate" });
    await expect(execute("UPDATE expense_claims SET amount_minor=1 WHERE id=$1", [claimId])).rejects.toThrow("CLAIM_DECIDED_IMMUTABLE");
  });
});
