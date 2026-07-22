import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { resetDb, rawExec } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createCertificate } from "../src/repositories/certificates";
import { createPayment } from "../src/repositories/payments";
import { loadWorkspaceFinancials } from "../src/repositories/financials";

describe("Milestone 7 cash-in and revenue definitions", () => {
  beforeEach(() => resetDb());

  it("reconciles every cash category without treating credit or VAT as revenue", async () => {
    const clientId = await createClient({ name: "Cash Client", company: null, address: null, phone: null,
      email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-2026-CASH", { name: "Cash Project", clientId,
      country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE",
      currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: "CASH-1", title: null, valueMinor: 100_000_00,
      vatBp: 1400, retentionBp: 500, withholdingBp: 0, advanceMinor: 10_000_00,
      advanceRecoveryMethod: "MANUAL", performanceBondBp: 0, performanceBondBank: null,
      performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
      valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null,
      signedDate: "2026-01-01", notes: null });
    const approvedId = await createCertificate(1, { contractId, number: "PC-1", date: "2026-02-01",
      submissionDate: "2026-02-01", dueDateOverride: null, description: "Approved work",
      grossMinor: 50_000_00, discountMinor: 0, manualAdvanceRecoveryMinor: 0, status: "APPROVED" });
    await createCertificate(2, { contractId, number: "PC-2", date: "2026-02-02",
      submissionDate: null, dueDateOverride: null, description: "Prepared work",
      grossMinor: 20_000_00, discountMinor: 0, manualAdvanceRecoveryMinor: 0, status: "DRAFT" });

    await createPayment({ contractId, kind: "CERTIFICATE", number: "COLL-1", date: "2026-03-01",
      amountMinor: 30_000_00, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
    [{ certificateId: approvedId, amountMinor: 20_000_00 }]);
    await createPayment({ contractId, kind: "ADVANCE", number: "ADV-1", date: "2026-01-05",
      amountMinor: 10_000_00, method: "BANK_TRANSFER", bank: null, reference: null, notes: null }, []);
    await createPayment({ contractId, kind: "RETENTION_RELEASE", number: "RET-1", date: "2026-04-01",
      amountMinor: 2_000_00, method: "BANK_TRANSFER", bank: null, reference: null, notes: null }, []);

    const workspace = await loadWorkspaceFinancials();
    const state = workspace.contractStates.get(contractId)!;
    const project = workspace.projects.find((row) => row.project.id === projectId)!;
    expect(state.billableRevenueMinor).toBe(70_000_00);
    expect(state.certifiedBaseMinor).toBe(50_000_00);
    expect(state.invoicedAmountMinor).toBe(54_500_00);
    expect(state.certificateCollectionsMinor).toBe(20_000_00);
    expect(state.unallocatedCustomerCreditMinor).toBe(10_000_00);
    expect(state.advanceReceivedMinor).toBe(10_000_00);
    expect(state.retentionReleasedMinor).toBe(2_000_00);
    expect(state.totalActualCashInMinor).toBe(42_000_00);
    expect(state.outstandingReceivablesMinor).toBe(34_500_00);
    expect(state.remainingUncertifiedMinor).toBe(50_000_00);
    expect(project.revenueEgp).toBe(50_000_00);
    expect(project.totalActualCashInEgp).toBe(42_000_00);
    expect(workspace.costsByProject.get(projectId)!.recognizedRevenueEgp).toBe(50_000_00);

    rawExec(`UPDATE contracts SET archived_at='2026-05-01' WHERE id=${contractId}`);
    const activeScope = await loadWorkspaceFinancials();
    expect(activeScope.cashIn).toHaveLength(0);
    expect(activeScope.projects.find((row) => row.project.id === projectId)!.totalActualCashInMinor).toBe(0);
  });
});
