import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { resetDb, raw, rawExec } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createStage, updateStage } from "../src/repositories/stages";
import { createAssignment, createPerson, createPersonPayment } from "../src/repositories/people";
import { reconcileMilestoneCertificates } from "../src/repositories/milestoneCertificates";
import { setCertificateStatus } from "../src/repositories/certificates";
import { createPayment } from "../src/repositories/payments";
import { loadWorkspaceFinancials } from "../src/repositories/financials";

describe("Milestone 6 repository cost views", () => {
  beforeEach(() => resetDb());

  it("moves team fees from commitment to accrual to cash only when each source event occurs", async () => {
    const clientId = await createClient({
      name: "Cost Client", company: null, address: null, phone: null, email: null,
      taxNumber: null, contacts: null, notes: null,
    });
    const projectId = await createProject("PRJ-2026-COST", {
      name: "Cost Project", clientId, country: null, city: null, manager: null,
      discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP",
      fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null,
    });
    const stageId = await createStage({
      projectId, name: "IFC", sortOrder: 0, startDate: "2026-01-01", endDate: "2026-02-01",
      status: "PLANNED", completionBp: 0, engineers: null, notes: null,
    });
    const contractId = await createContract({
      projectId, number: "COST-1", title: null, valueMinor: 100_000_00,
      vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0,
      advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
      performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30,
      paymentTermsNotes: null, valuationMode: "MILESTONES",
      milestones: JSON.stringify([{ title: "IFC", percentBp: 10_000, stageId, done: false, certificateId: null }]),
      drawings: null, attachments: null, signedDate: null, notes: null,
    });
    const personId = await createPerson({
      type: "FREELANCER", name: "Cost Engineer", specialization: "BIM", phone: null,
      email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null,
      currency: "EGP", notes: null, isActive: true,
    });
    const assignmentId = await createAssignment({
      personId, projectId, agreedMinor: 20_000_00, currency: "EGP",
      fxRateMicro: 1_000_000, scope: null, progressNote: null,
    });

    let profile = (await loadWorkspaceFinancials()).costsByProject.get(projectId)!;
    expect(profile.committedCostEgp).toBe(20_000_00);
    expect(profile.accruedCostEgp).toBe(0);
    expect(profile.actualPaidCostEgp).toBe(0);
    expect(profile.forecastCostEgp).toBe(20_000_00);

    await updateStage(stageId, {
      projectId, name: "IFC", sortOrder: 0, startDate: "2026-01-01", endDate: "2026-02-01",
      status: "COMPLETED", completionBp: 10_000, engineers: null, notes: null,
    });
    await reconcileMilestoneCertificates(contractId);
    const certificateId = raw<{ id: number }>("SELECT id FROM payment_certificates WHERE deleted_at IS NULL")[0]!.id;
    await setCertificateStatus(certificateId, "APPROVED");
    const state = (await loadWorkspaceFinancials()).contractStates.get(contractId)!;
    const payable = state.certificates.find((row) => row.certificate.id === certificateId)!.unpaidMinor;
    await createPayment(
      { contractId, kind: "CERTIFICATE", number: "RCPT-1", date: "2026-03-01", amountMinor: payable,
        method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
      [{ certificateId, amountMinor: payable }],
    );

    profile = (await loadWorkspaceFinancials()).costsByProject.get(projectId)!;
    expect(profile.actualCashInEgp).toBe(payable);
    expect(profile.accruedCostEgp).toBe(20_000_00);
    expect(profile.actualPaidCostEgp).toBe(0);

    await createPersonPayment({ assignmentId, date: "2026-03-02", amountMinor: 5_000_00, note: "First fee" });
    profile = (await loadWorkspaceFinancials()).costsByProject.get(projectId)!;
    expect(profile.actualPaidCostEgp).toBe(5_000_00);
    expect(profile.accruedCostEgp).toBe(15_000_00);
    expect(profile.committedCostEgp).toBe(20_000_00);
    expect(profile.forecastCostEgp).toBe(20_000_00);

    rawExec(`UPDATE project_assignments SET archived_at='2026-03-03' WHERE id=${assignmentId}`);
    profile = (await loadWorkspaceFinancials()).costsByProject.get(projectId)!;
    expect(profile.actualPaidCostEgp).toBe(5_000_00);
    expect(profile.accruedCostEgp).toBe(15_000_00);
    expect(profile.committedCostEgp).toBe(20_000_00);
  });

  it("counts unallocated client money in cash profit without treating it as collection", async () => {
    const clientId = await createClient({ name: "Credit Client", company: null, address: null, phone: null,
      email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-2026-CREDIT", { name: "Credit Project", clientId,
      country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE",
      currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: "CREDIT-1", title: null, valueMinor: 10_000_00,
      vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL",
      performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30,
      paymentTermsNotes: null, valuationMode: "DRAWINGS", milestones: null, drawings: null,
      attachments: null, signedDate: null, notes: null });
    await createPayment({ contractId, kind: "CERTIFICATE", number: "UNALLOCATED", date: "2026-03-01",
      amountMinor: 1_000_00, method: "BANK_TRANSFER", bank: null, reference: null, notes: null }, []);

    const ws = await loadWorkspaceFinancials();
    const profile = ws.costsByProject.get(projectId)!;
    expect(profile.actualCashInEgp).toBe(1_000_00);
    expect(profile.cashProfitEgp).toBe(1_000_00);
    expect(ws.projects.find((row) => row.project.id === projectId)!.totalPaidMinor).toBe(0);
  });
});
