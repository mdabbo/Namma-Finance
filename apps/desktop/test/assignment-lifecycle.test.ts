import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { rawExec, rawOne, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createCertificate, nextCertificateSeq, setCertificateStatus } from "../src/repositories/certificates";
import { createPayment } from "../src/repositories/payments";
import {
  cancelAssignment,
  completeAssignment,
  createAssignment,
  createPerson,
  createPersonPayment,
  deleteAssignment,
  deletePerson,
  listAssignmentsByProject,
} from "../src/repositories/people";
import { loadWorkspaceFinancials } from "../src/repositories/financials";

/**
 * Milestone 2: an assignment's lifecycle decides how its money is treated, and
 * archiving decides only whether it is shown.
 *
 * Before this, archiving was the only signal available, so an archived
 * assignment kept committing its full agreed fee and kept raising team-payment
 * alerts. Every assertion here reads the derived financial state, not the UI.
 */

beforeEach(() => resetDb());

let seq = 0;

/** A project whose single certificate can be paid to release the team fee. */
async function workspace(agreedMinor = 60_000) {
  seq += 1;
  const clientId = await createClient({
    name: `Client ${seq}`, company: null, address: null, phone: null,
    email: null, taxNumber: null, contacts: null, notes: null,
  });
  const projectId = await createProject(`PRJ-2026-${String(seq).padStart(3, "0")}`, {
    name: `Project ${seq}`, clientId, country: null, city: null, manager: null,
    discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP",
    fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null,
  });
  const contractId = await createContract({
    projectId, number: `C-${seq}`, title: null, valueMinor: 200_000, vatBp: 0,
    retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL",
    performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null,
    paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM",
    milestones: null, drawings: null, attachments: null, signedDate: null, notes: null,
  });
  const personId = await createPerson({
    type: "FREELANCER", name: `Person ${seq}`, specialization: null, phone: null,
    email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null,
    currency: "EGP", notes: null, isActive: true,
  });
  const assignmentId = await createAssignment({
    personId, projectId, agreedMinor, currency: "EGP", fxRateMicro: 1_000_000,
    scope: "Design", progressNote: null,
  });
  return { projectId, contractId, personId, assignmentId };
}

/** Certify and collect `grossMinor`, which releases the team's matching share. */
async function collect(contractId: number, grossMinor: number, number: string) {
  const certificateId = await createCertificate(await nextCertificateSeq(contractId), {
    contractId, number, date: "2026-07-01", submissionDate: "2026-07-01",
    dueDateOverride: null, description: null, grossMinor, discountMinor: 0,
    manualAdvanceRecoveryMinor: null, status: "APPROVED",
  });
  await createPayment({
    contractId, kind: "CERTIFICATE", number: `PAY-${number}`, date: "2026-07-02",
    amountMinor: grossMinor, method: "CASH", bank: null, reference: null, notes: null,
  }, [{ certificateId, amountMinor: grossMinor }]);
  return certificateId;
}

async function position(assignmentId: number) {
  const workspaceState = await loadWorkspaceFinancials();
  return workspaceState.teamAccounts.find((account) => account.assignmentId === assignmentId);
}

async function alerts(assignmentId: number) {
  const workspaceState = await loadWorkspaceFinancials();
  return workspaceState.teamPayables.filter((item) => item.assignmentId === assignmentId);
}

async function committedEgp(projectId: number) {
  const workspaceState = await loadWorkspaceFinancials();
  return workspaceState.costsByProject.get(projectId)?.committedCostEgp ?? 0;
}

async function accruedEgp(projectId: number) {
  const workspaceState = await loadWorkspaceFinancials();
  return workspaceState.costsByProject.get(projectId)?.accruedCostEgp ?? 0;
}

describe("active assignments", () => {
  it("commits the whole agreed fee before any work is released", async () => {
    const { projectId, assignmentId } = await workspace();
    expect(await position(assignmentId)).toMatchObject({
      lifecycleStatus: "ACTIVE", accruedMinor: 0, dueMinor: 0, committedMinor: 60_000,
    });
    expect(await committedEgp(projectId)).toBe(60_000);
    expect(await alerts(assignmentId)).toHaveLength(0);
  });

  it("accrues and alerts once the client pays part of the work", async () => {
    const { projectId, contractId, assignmentId } = await workspace();
    // Half the contract collected releases half the agreed fee.
    await collect(contractId, 100_000, "PC-1");
    expect(await position(assignmentId)).toMatchObject({
      accruedMinor: 30_000, dueMinor: 30_000, committedMinor: 60_000,
    });
    expect(await accruedEgp(projectId)).toBe(30_000);
    expect(await alerts(assignmentId)).toHaveLength(1);
  });
});

describe("completed assignments", () => {
  it("keeps unpaid earned value payable and the fee committed", async () => {
    const { projectId, contractId, assignmentId } = await workspace();
    await collect(contractId, 100_000, "PC-1");
    await completeAssignment(assignmentId);

    expect(await position(assignmentId)).toMatchObject({
      lifecycleStatus: "COMPLETED", accruedMinor: 30_000, dueMinor: 30_000, committedMinor: 60_000,
    });
    expect(await alerts(assignmentId)).toHaveLength(1);
    expect(await committedEgp(projectId)).toBe(60_000);
  });

  it("settles to nothing owed once the person is paid", async () => {
    const { contractId, assignmentId } = await workspace();
    await collect(contractId, 100_000, "PC-1");
    await completeAssignment(assignmentId);
    await createPersonPayment({ assignmentId, date: "2026-07-05", amountMinor: 30_000, note: null });

    expect(await position(assignmentId)).toMatchObject({ dueMinor: 0, paidMinor: 30_000 });
    expect(await alerts(assignmentId)).toHaveLength(0);
  });

  it("records the completion date and refuses to complete twice", async () => {
    const { assignmentId } = await workspace();
    await completeAssignment(assignmentId);
    expect(rawOne<{ completed_at: string | null }>(
      `SELECT completed_at FROM project_assignments WHERE id=${assignmentId}`,
    )?.completed_at).toBeTruthy();
    await expect(completeAssignment(assignmentId)).rejects.toThrow("ASSIGNMENT_NOT_ACTIVE");
  });
});

describe("cancelled assignments", () => {
  it("removes the whole commitment when nothing was earned", async () => {
    const { projectId, assignmentId } = await workspace();
    await cancelAssignment(assignmentId, "Client withdrew the package");

    expect(await position(assignmentId)).toMatchObject({
      lifecycleStatus: "CANCELLED", accruedMinor: 0, dueMinor: 0, committedMinor: 0,
    });
    expect(await committedEgp(projectId)).toBe(0);
    expect(await alerts(assignmentId)).toHaveLength(0);
  });

  it("preserves earned and paid history and drops only the unearned remainder", async () => {
    const { projectId, contractId, assignmentId } = await workspace();
    await collect(contractId, 100_000, "PC-1");
    await createPersonPayment({ assignmentId, date: "2026-07-05", amountMinor: 10_000, note: null });
    await cancelAssignment(assignmentId, "Scope reduced by the client");

    expect(await position(assignmentId)).toMatchObject({
      lifecycleStatus: "CANCELLED",
      accruedMinor: 30_000,   // earned before cancelling, kept
      paidMinor: 10_000,      // already paid, kept
      dueMinor: 20_000,       // still owed
      committedMinor: 30_000, // the unearned 30 000 is gone
    });
    expect(await committedEgp(projectId)).toBe(30_000);
    // Still owed, so it still needs the office's attention.
    expect(await alerts(assignmentId)).toHaveLength(1);
  });

  /** The reason the frozen figure exists. */
  it("does not accrue value from certificates paid after cancellation", async () => {
    const { contractId, assignmentId } = await workspace();
    await collect(contractId, 100_000, "PC-1");
    await cancelAssignment(assignmentId, "Stopped");
    expect(await position(assignmentId)).toMatchObject({ accruedMinor: 30_000 });

    // The client pays the rest of the contract afterwards.
    await collect(contractId, 100_000, "PC-2");
    expect(await position(assignmentId)).toMatchObject({
      accruedMinor: 30_000, committedMinor: 30_000,
    });
  });

  it("requires a reason and is final", async () => {
    const { assignmentId } = await workspace();
    await expect(cancelAssignment(assignmentId, "   ")).rejects.toThrow("CANCELLATION_REASON_REQUIRED");
    await cancelAssignment(assignmentId, "Called off");
    await expect(cancelAssignment(assignmentId, "again")).rejects.toThrow("ASSIGNMENT_ALREADY_CANCELLED");
    expect(() => rawExec(
      `UPDATE project_assignments SET lifecycle_status='ACTIVE' WHERE id=${assignmentId}`,
    )).toThrow(/CANCELLED_ASSIGNMENT_IS_FINAL/);
  });

  it("audits the transition with its reason", async () => {
    const { assignmentId } = await workspace();
    await cancelAssignment(assignmentId, "Client withdrew");
    const entry = rawOne<{ action: string; reason: string | null }>(
      `SELECT action, reason FROM audit_logs WHERE entity_type='project_assignment'
         AND action='STATUS_CHANGE' ORDER BY id DESC LIMIT 1`,
    );
    expect(entry).toMatchObject({ action: "STATUS_CHANGE", reason: "Client withdrew" });
  });

  /**
   * Audit regression: the frozen figure decides committed cost and the balance
   * owed, and it used to be rewritable by any UPDATE that left lifecycle_status
   * alone — no trigger validated it and no audit row was written. Reproduced
   * against this schema before migration 0004.
   */
  it("refuses to rewrite the frozen earned figure or the reason after cancelling", async () => {
    const { contractId, assignmentId } = await workspace();
    await collect(contractId, 100_000, "PC-1");
    await cancelAssignment(assignmentId, "Scope stopped");
    const frozen = () => rawOne<{ e: number; r: string }>(
      `SELECT earned_minor_at_cancellation AS e, cancellation_reason AS r
         FROM project_assignments WHERE id=${assignmentId}`,
    );
    const before = frozen();

    expect(() => rawExec(
      `UPDATE project_assignments SET earned_minor_at_cancellation=999999 WHERE id=${assignmentId}`,
    )).toThrow(/CANCELLATION_EVIDENCE_IS_FINAL/);
    expect(() => rawExec(
      `UPDATE project_assignments SET cancellation_reason='rewritten' WHERE id=${assignmentId}`,
    )).toThrow(/CANCELLATION_EVIDENCE_IS_FINAL/);
    expect(() => rawExec(
      `UPDATE project_assignments SET cancelled_at='2020-01-01' WHERE id=${assignmentId}`,
    )).toThrow(/CANCELLATION_EVIDENCE_IS_FINAL/);

    expect(frozen()).toEqual(before);
  });

  it("refuses to park a frozen earned figure on work that was never cancelled", async () => {
    const { assignmentId } = await workspace();
    expect(() => rawExec(
      `UPDATE project_assignments SET earned_minor_at_cancellation=50_000 WHERE id=${assignmentId}`,
    )).toThrow(/FROZEN_EARNED_REQUIRES_CANCELLATION/);
    expect(() => rawExec(
      `INSERT INTO project_assignments (person_id,project_id,agreed_minor,currency,fx_rate_micro,earned_minor_at_cancellation)
       SELECT person_id,project_id,agreed_minor,currency,fx_rate_micro,1000
         FROM project_assignments WHERE id=${assignmentId}`,
    )).toThrow(/FROZEN_EARNED_REQUIRES_CANCELLATION/);
  });

  /**
   * Race regression: the frozen figure is derived from a workspace-wide read and
   * is final once written, so the derivation must not interleave with a team
   * payment or a collection. cancelAssignment now runs on the same global
   * financial lock as payments and reconciliation.
   */
  it("freezes a figure consistent with the evidence when a payment races the cancellation", async () => {
    const { contractId, assignmentId } = await workspace();
    await collect(contractId, 100_000, "PC-1");

    await Promise.all([
      cancelAssignment(assignmentId, "Called off mid-run"),
      createPersonPayment({ assignmentId, date: "2026-07-06", amountMinor: 10_000, note: "racing" }),
    ]);

    // Whichever order the lock granted, the frozen figure is the earned value
    // released by the collected certificate — never a partial or doubled read.
    const row = rawOne<{ e: number }>(
      `SELECT earned_minor_at_cancellation AS e FROM project_assignments WHERE id=${assignmentId}`,
    );
    expect(row?.e).toBe(30_000);
    // Paid money is preserved and committed cost never drops below it.
    const p = await position(assignmentId);
    expect(p).toMatchObject({ accruedMinor: 30_000, paidMinor: 10_000, dueMinor: 20_000 });
    expect(p!.committedMinor).toBeGreaterThanOrEqual(p!.paidMinor);
  });
});

describe("archiving is visibility, not accounting", () => {
  it("silences alerts for an archived completed assignment but keeps its cost", async () => {
    const { projectId, contractId, assignmentId } = await workspace();
    await collect(contractId, 100_000, "PC-1");
    await completeAssignment(assignmentId);
    await deleteAssignment(assignmentId);

    // Hidden from the project's list…
    expect(await listAssignmentsByProject(projectId)).toHaveLength(0);
    // …no longer nags the office…
    expect(await alerts(assignmentId)).toHaveLength(0);
    // …but the money it earned and committed is still the project's cost.
    const account = await position(assignmentId);
    expect(account).toMatchObject({
      archived: true, lifecycleStatus: "COMPLETED", accruedMinor: 30_000, committedMinor: 60_000,
    });
    expect(await committedEgp(projectId)).toBe(60_000);
    expect(await accruedEgp(projectId)).toBe(30_000);
  });

  it("stops alerts when the person is archived", async () => {
    const { contractId, personId, assignmentId } = await workspace();
    await collect(contractId, 100_000, "PC-1");
    expect(await alerts(assignmentId)).toHaveLength(1);

    await deletePerson(personId);
    expect(await alerts(assignmentId)).toHaveLength(0);
    // The balance is still owed; it simply stops generating new work.
    expect(await position(assignmentId)).toMatchObject({ dueMinor: 30_000 });
  });
});

describe("project cost reconciles across lifecycles", () => {
  it("sums committed cost from each assignment's lifecycle treatment", async () => {
    const { projectId, contractId, personId } = await workspace(60_000);
    await collect(contractId, 100_000, "PC-1");

    // A second assignment on the same project, cancelled after earning nothing.
    const cancelled = await createAssignment({
      personId, projectId, agreedMinor: 40_000, currency: "EGP",
      fxRateMicro: 1_000_000, scope: "Extra", progressNote: null,
    });
    await cancelAssignment(cancelled, "Not needed");

    // 60 000 still committed by the active assignment; the cancelled one
    // contributes only what it earned before stopping.
    const cancelledPosition = await position(cancelled);
    expect(cancelledPosition?.committedMinor).toBe(cancelledPosition?.accruedMinor);
    expect(await committedEgp(projectId)).toBe(60_000 + (cancelledPosition?.committedMinor ?? 0));
  });

  it("keeps the dashboard team-payment alert count in step with what is owed", async () => {
    const { contractId, assignmentId } = await workspace();
    const workspaceBefore = await loadWorkspaceFinancials();
    expect(workspaceBefore.teamPayables).toHaveLength(0);

    await collect(contractId, 200_000, "PC-1");
    const workspaceAfter = await loadWorkspaceFinancials();
    expect(workspaceAfter.teamPayables).toHaveLength(1);
    expect(workspaceAfter.teamPayables[0]).toMatchObject({ assignmentId, dueMinor: 60_000 });

    await deleteAssignment(assignmentId);
    expect((await loadWorkspaceFinancials()).teamPayables).toHaveLength(0);
  });
});

describe("the schema guards lifecycle evidence", () => {
  it("refuses a cancelled row without a date, reason and frozen figure", async () => {
    const { assignmentId } = await workspace();
    expect(() => rawExec(
      `UPDATE project_assignments SET lifecycle_status='CANCELLED' WHERE id=${assignmentId}`,
    )).toThrow(/CANCELLED_ASSIGNMENT_REQUIRES_EVIDENCE/);
  });

  it("refuses a completed row without a completion date", async () => {
    const { assignmentId } = await workspace();
    expect(() => rawExec(
      `UPDATE project_assignments SET lifecycle_status='COMPLETED' WHERE id=${assignmentId}`,
    )).toThrow(/COMPLETED_ASSIGNMENT_REQUIRES_DATE/);
  });

  it("refuses an unknown lifecycle value", async () => {
    const { assignmentId } = await workspace();
    expect(() => rawExec(
      `UPDATE project_assignments SET lifecycle_status='PARKED' WHERE id=${assignmentId}`,
    )).toThrow(/INVALID_ASSIGNMENT_LIFECYCLE/);
  });

  it("defaults new assignments to ACTIVE", async () => {
    const { assignmentId } = await workspace();
    expect(rawOne<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM project_assignments WHERE id=${assignmentId}`,
    )?.lifecycle_status).toBe("ACTIVE");
  });
});

describe("unrelated status changes stay unaffected", () => {
  it("does not let a certificate status change alter lifecycle", async () => {
    const { contractId, assignmentId } = await workspace();
    const certificateId = await createCertificate(await nextCertificateSeq(contractId), {
      contractId, number: "PC-X", date: "2026-07-01", submissionDate: "2026-07-01",
      dueDateOverride: null, description: null, grossMinor: 50_000, discountMinor: 0,
      manualAdvanceRecoveryMinor: null, status: "SUBMITTED",
    });
    await setCertificateStatus(certificateId, "APPROVED");
    expect(await position(assignmentId)).toMatchObject({ lifecycleStatus: "ACTIVE" });
  });
});

/**
 * M5: the frozen earned figure is derived by the caller, and migration 0004
 * makes it final once written — so a wrong figure is permanent. The write is
 * now owned by `cancel_assignment_atomic`, which re-checks the assignment
 * inside its own transaction and bounds the figure.
 *
 * The bound enforcement itself is asserted in `cargo test`, where the command
 * lives. These cover the behaviour reachable from the repository.
 */
describe("cancellation evidence is bounded and written under one guard", () => {
  it("freezes a figure inside the agreed fee and refuses a second cancellation", async () => {
    const { assignmentId } = await workspace(40_000);

    await cancelAssignment(assignmentId, "Client withdrew the package");
    const first = rawOne<{ earned_minor_at_cancellation: number; cancellation_reason: string }>(
      `SELECT earned_minor_at_cancellation, cancellation_reason FROM project_assignments WHERE id=${assignmentId}`,
    );
    expect(first?.earned_minor_at_cancellation).toBeGreaterThanOrEqual(0);
    expect(first?.earned_minor_at_cancellation).toBeLessThanOrEqual(40_000);
    expect(first?.cancellation_reason).toBe("Client withdrew the package");

    await expect(cancelAssignment(assignmentId, "second attempt")).rejects.toThrow(
      "ASSIGNMENT_ALREADY_CANCELLED",
    );
    // The refused attempt changed nothing — not the figure, not the reason.
    expect(
      rawOne(
        `SELECT earned_minor_at_cancellation, cancellation_reason FROM project_assignments WHERE id=${assignmentId}`,
      ),
    ).toEqual(first);
  });

  it("leaves the assignment untouched when the reason is blank", async () => {
    const { assignmentId } = await workspace(40_000);
    await expect(cancelAssignment(assignmentId, "   ")).rejects.toThrow(
      "CANCELLATION_REASON_REQUIRED",
    );
    const row = rawOne<{ lifecycle_status: string; earned_minor_at_cancellation: number | null }>(
      `SELECT lifecycle_status, earned_minor_at_cancellation FROM project_assignments WHERE id=${assignmentId}`,
    );
    expect(row?.lifecycle_status).toBe("ACTIVE");
    expect(row?.earned_minor_at_cancellation).toBeNull();
  });

  /**
   * Pins the deliberate asymmetry with payment-driven certificate status, so a
   * later reader sees it was decided rather than overlooked — and so moving the
   * derivation into Rust is a visible change here rather than a silent one.
   */
  it("records that the derivation still lives in the caller, and what Rust checks instead", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src-tauri/src/lib.rs"),
      "utf8",
    );
    const command = source.slice(source.indexOf("async fn cancel_assignment_transaction"));
    expect(source).toContain("KNOWN LIMIT, deliberate");
    expect(command).toContain("FROZEN_EARNED_OUT_OF_RANGE");
    expect(command).toContain("ASSIGNMENT_ALREADY_CANCELLED");
  });
});
