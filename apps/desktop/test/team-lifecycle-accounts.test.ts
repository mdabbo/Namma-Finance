import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { assignmentCostPosition, assignmentRaisesAlerts, toEgpPiasters } from "@mep/core";
import { raw, rawExec, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createCertificate, nextCertificateSeq } from "../src/repositories/certificates";
import { createPayment } from "../src/repositories/payments";
import {
  cancelAssignment,
  completeAssignment,
  createAssignment,
  createPerson,
  createPersonPayment,
  deleteAssignment,
  listAssignmentsByPerson,
} from "../src/repositories/people";
import { loadWorkspaceFinancials } from "../src/repositories/financials";

beforeEach(() => resetDb());

let seq = 0;

/**
 * A project whose single contract is billed in equal certificates, so a known
 * fraction of an assignment's agreed fee can be released on demand. Contract
 * value 100 (in minor units 100_000) with no VAT/retention/advance, so a
 * collected certificate releases exactly its share of the fee.
 */
async function workspace(agreedMinor = 100_000) {
  seq += 1;
  const clientId = await createClient({ name: `Client ${seq}`, company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject(`PRJ-2026-${String(700 + seq)}`, {
    name: `Project ${seq}`, clientId, country: null, city: null, manager: null, discipline: "MULTI",
    projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000,
    startDate: null, endDate: null, progressBp: 0, description: null,
  });
  const contractId = await createContract({
    projectId, number: `C-${seq}`, title: null, valueMinor: 100_000, vatBp: 0, retentionBp: 0,
    withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
    performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
    valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null,
  });
  const personId = await createPerson({
    type: "FREELANCER", name: `Person ${seq}`, specialization: null, phone: null, email: null,
    bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true,
  });
  const assignmentId = await createAssignment({
    personId, projectId, agreedMinor, currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null,
  });
  return { clientId, projectId, contractId, personId, assignmentId };
}

/** Collect `grossMinor` of the contract, releasing that share of the fee. */
async function collect(contractId: number, grossMinor: number, tag: string) {
  const certificateId = await createCertificate(await nextCertificateSeq(contractId), {
    contractId, number: `PC-${tag}`, date: "2026-07-01", submissionDate: "2026-07-01", dueDateOverride: null,
    description: null, grossMinor, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED",
  });
  await createPayment(
    { contractId, kind: "CERTIFICATE", number: `PAY-${tag}`, date: "2026-07-02", amountMinor: grossMinor, method: "CASH", bank: null, reference: null, notes: null },
    [{ certificateId, amountMinor: grossMinor }],
  );
  return certificateId;
}

const accountOf = async (assignmentId: number) =>
  (await loadWorkspaceFinancials()).teamAccounts.find((a) => a.assignmentId === assignmentId);

describe("Milestone 3 — lifecycle-aware team accounts and payments", () => {
  // (1)
  it("a cancelled assignment shows due from frozen earned value, not agreed minus paid", async () => {
    // agreed 100, earned 40, paid 10 -> due 30 (never 90).
    const { contractId, assignmentId } = await workspace(100_000);
    await collect(contractId, 40_000, "A1");
    await createPersonPayment({ assignmentId, date: "2026-07-10", amountMinor: 10_000, note: "on account" });
    await cancelAssignment(assignmentId, "Client paused the package");

    const account = (await accountOf(assignmentId))!;
    expect(account.lifecycleStatus).toBe("CANCELLED");
    expect(account.accruedMinor).toBe(40_000);
    expect(account.paidMinor).toBe(10_000);
    expect(account.dueMinor).toBe(30_000);
    // The legacy balance would have been 100_000 - 10_000 = 90_000.
    expect(account.dueMinor).not.toBe(90_000);
    // Committed drops to what was earned: the unearned remainder is released.
    expect(account.committedMinor).toBe(40_000);
  });

  // (2)
  it("client certificates paid after cancellation do not increase earnings", async () => {
    const { contractId, assignmentId } = await workspace(100_000);
    await collect(contractId, 40_000, "B1");
    await cancelAssignment(assignmentId, "Scope withdrawn");
    const before = (await accountOf(assignmentId))!;

    await collect(contractId, 50_000, "B2");

    const after = (await accountOf(assignmentId))!;
    expect(after.accruedMinor).toBe(before.accruedMinor);
    expect(after.dueMinor).toBe(before.dueMinor);
  });

  // (3) + (4)
  it("rejects a payment above the current due and writes neither payment nor expense", async () => {
    const { assignmentId, contractId } = await workspace(100_000);
    await collect(contractId, 20_000, "C1");
    const expensesBefore = raw("SELECT id FROM expenses").length;

    await expect(
      createPersonPayment({ assignmentId, date: "2026-07-11", amountMinor: 20_001, note: "too much" }),
    ).rejects.toThrow("PERSON_PAYMENT_EXCEEDS_DUE");

    expect(raw(`SELECT id FROM person_payments WHERE assignment_id=${assignmentId}`)).toHaveLength(0);
    expect(raw("SELECT id FROM expenses").length).toBe(expensesBefore);

    // Exactly the due amount is accepted, so the limit is a ceiling, not a block.
    await createPersonPayment({ assignmentId, date: "2026-07-11", amountMinor: 20_000, note: "in full" });
    expect((await accountOf(assignmentId))!.dueMinor).toBe(0);
  });

  // (5)
  it("a completed assignment keeps its commitment but only earned value is payable", async () => {
    const { contractId, assignmentId } = await workspace(100_000);
    await collect(contractId, 30_000, "D1");
    await completeAssignment(assignmentId);

    const account = (await accountOf(assignmentId))!;
    expect(account.lifecycleStatus).toBe("COMPLETED");
    // Commitment stays the whole agreed fee: the scope was delivered.
    expect(account.committedMinor).toBe(100_000);
    expect(account.accruedMinor).toBe(30_000);
    expect(account.dueMinor).toBe(30_000);
    await expect(
      createPersonPayment({ assignmentId, date: "2026-07-12", amountMinor: 30_001, note: "over" }),
    ).rejects.toThrow("PERSON_PAYMENT_EXCEEDS_DUE");
  });

  // (6)
  it("an archived assignment keeps its cost but raises no alert and takes no new payment", async () => {
    const { contractId, assignmentId } = await workspace(100_000);
    await collect(contractId, 40_000, "E1");
    await deleteAssignment(assignmentId); // archive = visibility only

    const account = (await accountOf(assignmentId))!;
    expect(account.archived).toBe(true);
    // Historical cost survives archiving.
    expect(account.accruedMinor).toBe(40_000);
    expect(account.committedMinor).toBe(100_000);
    expect(
      assignmentRaisesAlerts({ archived: true, personArchived: false, dueMinor: account.dueMinor }),
    ).toBe(false);
    const workspaceState = await loadWorkspaceFinancials();
    expect(workspaceState.teamPayables.some((item) => item.assignmentId === assignmentId)).toBe(false);
    await expect(
      createPersonPayment({ assignmentId, date: "2026-07-13", amountMinor: 1_000, note: "after archive" }),
    ).rejects.toThrow("ARCHIVED_ASSIGNMENT_CANNOT_BE_PAID");
  });

  // (7) + (8)
  it("Person Detail, Project Team and the printed statement read one account position", async () => {
    const { contractId, personId, assignmentId } = await workspace(100_000);
    await collect(contractId, 60_000, "F1");
    await createPersonPayment({ assignmentId, date: "2026-07-14", amountMinor: 25_000, note: "interim" });

    // Project Team reads teamAccounts directly.
    const shared = (await accountOf(assignmentId))!;

    // Person Detail (and its statement) derive the same position from the same
    // inputs through the shared core selector.
    const assignment = (await listAssignmentsByPerson(personId)).find((a) => a.id === assignmentId)!;
    const financials = await loadWorkspaceFinancials();
    const account = financials.teamAccounts.find((a) => a.assignmentId === assignmentId)!;
    const selector = assignmentCostPosition({
      lifecycle: assignment.lifecycleStatus,
      agreedMinor: assignment.agreedMinor,
      releasedMinor: account.accruedMinor,
      paidOutMinor: account.paidMinor,
      earnedAtCancellationMinor: assignment.earnedMinorAtCancellation,
    });

    expect(selector.earnedMinor).toBe(shared.accruedMinor);
    expect(selector.paidMinor).toBe(shared.paidMinor);
    expect(selector.dueMinor).toBe(shared.dueMinor);
    expect(selector.committedMinor).toBe(shared.committedMinor);
    expect(shared.dueMinor).toBe(35_000);
  });

  // (9)
  it("an assignment already overpaid reports zero due, never a negative balance", async () => {
    const { contractId, assignmentId } = await workspace(100_000);
    await collect(contractId, 50_000, "G1");
    await createPersonPayment({ assignmentId, date: "2026-07-15", amountMinor: 50_000, note: "full" });
    // Reproduce an overpayment that predates the limit (or arrived by sync).
    rawExec(`INSERT INTO person_payments (assignment_id,date,amount_minor,note) VALUES (${assignmentId},'2026-07-16',20000,'legacy overpay')`);

    const account = (await accountOf(assignmentId))!;
    expect(account.paidMinor).toBe(70_000);
    expect(account.dueMinor).toBe(0);
    expect(account.dueMinor).toBeGreaterThanOrEqual(0);
    // Committed is never below money actually spent.
    expect(account.committedMinor).toBeGreaterThanOrEqual(account.paidMinor);
    // And no further payment is possible while nothing is due.
    await expect(
      createPersonPayment({ assignmentId, date: "2026-07-17", amountMinor: 1, note: "more" }),
    ).rejects.toThrow("PERSON_PAYMENT_EXCEEDS_DUE");
  });

  // (10)
  it("keeps the assignment's stored currency and FX on the payment and its expense", async () => {
    seq += 1;
    const clientId = await createClient({ name: "FX Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
    // Project and assignment are in SAR at a stored rate; the expense must
    // carry that same evidence rather than a re-derived or default rate.
    const projectId = await createProject("PRJ-2026-FX1", {
      name: "FX Project", clientId, country: null, city: null, manager: null, discipline: "MULTI",
      projectType: null, status: "ACTIVE", currency: "SAR", fxRateMicro: 12_900_000,
      startDate: null, endDate: null, progressBp: 0, description: null,
    });
    const contractId = await createContract({
      projectId, number: "C-FX1", title: null, valueMinor: 100_000, vatBp: 0, retentionBp: 0,
      withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
      performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
      valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null,
    });
    const personId = await createPerson({
      type: "EMPLOYEE", name: "FX Person", specialization: null, phone: null, email: null,
      bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "SAR", notes: null, isActive: true,
    });
    const assignmentId = await createAssignment({
      personId, projectId, agreedMinor: 100_000, currency: "SAR", fxRateMicro: 12_900_000,
      scope: null, progressNote: null,
    });
    await collect(contractId, 40_000, "FX1");
    const paymentId = await createPersonPayment({ assignmentId, date: "2026-07-18", amountMinor: 40_000, note: "SAR fee" });

    const expense = raw<{ currency: string; fx_rate_micro: number; amount_minor: number }>(
      `SELECT currency, fx_rate_micro, amount_minor FROM expenses WHERE person_payment_id=${paymentId}`,
    )[0]!;
    expect(expense.currency).toBe("SAR");
    expect(expense.fx_rate_micro).toBe(12_900_000);
    expect(expense.amount_minor).toBe(40_000);
    // The account reports minor units of the assignment's own currency; the
    // EGP consolidation uses the stored rate, not a live one.
    const account = (await accountOf(assignmentId))!;
    expect(account.currency).toBe("SAR");
    expect(account.paidMinor).toBe(40_000);
    expect(toEgpPiasters(account.paidMinor, "SAR", 12_900_000)).toBe(516_000);
  });
});
