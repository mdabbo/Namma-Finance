import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { computeDashboardOverview, dashboardCashInComponentsReconcile } from "@mep/core";
import { resetDb, rawExec } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract, updateContract } from "../src/repositories/contracts";
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

  /**
   * Milestone 4: the dashboard headline is TOTAL CASH IN, and the four
   * components are reported beside it. A workspace holding one of every inflow
   * proves the headline is not certificate collections and that the parts
   * account for it exactly.
   */
  it("reports total cash in with components that reconcile and never double-count", async () => {
    const clientId = await createClient({ name: "KPI Client", company: null, address: null, phone: null,
      email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-2026-KPI", { name: "KPI Project", clientId,
      country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE",
      currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: "KPI-1", title: null, valueMinor: 100_000_00,
      vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 10_000_00,
      advanceRecoveryMethod: "MANUAL", performanceBondBp: 0, performanceBondBank: null,
      performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
      valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null,
      signedDate: "2026-01-01", notes: null });
    const certificateId = await createCertificate(1, { contractId, number: "PC-1", date: "2026-02-01",
      submissionDate: "2026-02-01", dueDateOverride: null, description: "Certified work",
      grossMinor: 40_000_00, discountMinor: 0, manualAdvanceRecoveryMinor: 0, status: "APPROVED" });

    // One of every inflow: a collection, an advance, a retention release, and
    // customer money received without an allocation.
    await createPayment({ contractId, kind: "CERTIFICATE", number: "COLL-1", date: "2026-03-01",
      amountMinor: 25_000_00, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
    [{ certificateId, amountMinor: 15_000_00 }]);
    await createPayment({ contractId, kind: "ADVANCE", number: "ADV-1", date: "2026-01-05",
      amountMinor: 10_000_00, method: "BANK_TRANSFER", bank: null, reference: null, notes: null }, []);
    await createPayment({ contractId, kind: "RETENTION_RELEASE", number: "RET-1", date: "2026-04-01",
      amountMinor: 3_000_00, method: "BANK_TRANSFER", bank: null, reference: null, notes: null }, []);

    const workspace = await loadWorkspaceFinancials();
    const overview = computeDashboardOverview(workspace.projects, workspace.allExpenses);

    expect(overview.certificateCollectionsEgp).toBe(15_000_00);
    expect(overview.advanceReceivedEgp).toBe(10_000_00);
    expect(overview.retentionReleasedEgp).toBe(3_000_00);
    expect(overview.unallocatedCustomerCreditEgp).toBe(10_000_00);
    expect(overview.totalCashInEgp).toBe(38_000_00);

    // The headline is emphatically not the collection figure.
    expect(overview.totalCashInEgp).not.toBe(overview.certificateCollectionsEgp);
    expect(dashboardCashInComponentsReconcile(overview)).toBe(true);

    // Net cash position remains total actual cash in less actual cash out.
    expect(overview.netCashPositionEgp).toBe(overview.totalCashInEgp - overview.cashOutEgp);
  });

  /**
   * Audit regression. Cash figures must all be valued at the rate effective when
   * the cash arrived — the payment's. Certificate collections were valued at the
   * CERTIFICATE's snapshot rate instead, which is the basis for measuring a
   * receivable, not cash. As soon as a certificate was paid under a later
   * contract revision the two bases diverged and the reported components stopped
   * adding up to the reported total: a 40,000.00 EGP gap on a 2,400,000.00 EGP
   * headline in this fixture, money that appeared from nowhere on screen.
   */
  it("values collected cash at the payment's rate so components still reconcile across revisions", async () => {
    const clientId = await createClient({ name: "FX Client", company: null, address: null, phone: null,
      email: null, taxNumber: null, contacts: null, notes: null });
    // Non-EGP: toEgpPiasters only converts when the currency is not EGP.
    const projectId = await createProject("PRJ-2026-FX", { name: "FX Project", clientId,
      country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE",
      currency: "USD", fxRateMicro: 50_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractInput = {
      projectId, number: "FX-1", title: null, valueMinor: 100_000_00,
      vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0,
      advanceRecoveryMethod: "PROPORTIONAL" as const, performanceBondBp: 0,
      performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30,
      paymentTermsNotes: null, valuationMode: "LUMP_SUM" as const,
      milestones: null, drawings: null, attachments: null, signedDate: "2026-01-01", notes: null,
    };
    const contractId = await createContract(contractInput);
    // Certificate dated under revision 1, so its snapshot rate is 50.
    const certificateId = await createCertificate(1, { contractId, number: "PC-1", date: "2026-02-01",
      submissionDate: "2026-02-01", dueDateOverride: null, description: "Work",
      grossMinor: 40_000_00, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });

    // The rate moves, and a revision effective 2026-03-01 captures the new one.
    rawExec(`UPDATE projects SET fx_rate_micro=60000000 WHERE id=${projectId}`);
    await updateContract(contractId, { ...contractInput, valueMinor: 120_000_00 },
      { reason: "Scope increase", effectiveDate: "2026-03-01" });

    // Paid after the revision, so the cash arrived at rate 60.
    await createPayment({ contractId, kind: "CERTIFICATE", number: "COLL-1", date: "2026-04-01",
      amountMinor: 40_000_00, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
    [{ certificateId, amountMinor: 40_000_00 }]);

    const workspace = await loadWorkspaceFinancials();
    const overview = computeDashboardOverview(workspace.projects, workspace.allExpenses);

    // 40,000.00 USD at 60 EGP/USD — the rate when the money actually arrived,
    // not the 50 captured on the certificate.
    expect(overview.totalCashInEgp).toBe(2_400_000_00);
    expect(overview.certificateCollectionsEgp).toBe(2_400_000_00);
    expect(overview.certificateCollectionsEgp).not.toBe(2_000_000_00);
    expect(overview.unallocatedCustomerCreditEgp).toBe(0);
    expect(dashboardCashInComponentsReconcile(overview)).toBe(true);
  });

  it("keeps a part-allocated receipt adding back to the receipt exactly", async () => {
    const clientId = await createClient({ name: "Split Client", company: null, address: null, phone: null,
      email: null, taxNumber: null, contacts: null, notes: null });
    const projectId = await createProject("PRJ-2026-SPLIT", { name: "Split Project", clientId,
      country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE",
      currency: "USD", fxRateMicro: 30_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
    const contractId = await createContract({ projectId, number: "SPLIT-1", title: null, valueMinor: 100_000_00,
      vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL",
      performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30,
      paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null,
      attachments: null, signedDate: "2026-01-01", notes: null });
    const certificateId = await createCertificate(1, { contractId, number: "PC-1", date: "2026-02-01",
      submissionDate: "2026-02-01", dueDateOverride: null, description: "Work",
      grossMinor: 10_000_00, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    // An odd split so independent rounding of the two parts would drift.
    await createPayment({ contractId, kind: "CERTIFICATE", number: "PART-1", date: "2026-03-01",
      amountMinor: 33_333_33, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
    [{ certificateId, amountMinor: 10_000_00 }]);

    const overview = computeDashboardOverview(
      (await loadWorkspaceFinancials()).projects,
      (await loadWorkspaceFinancials()).allExpenses,
    );
    expect(dashboardCashInComponentsReconcile(overview)).toBe(true);
    expect(overview.certificateCollectionsEgp + overview.unallocatedCustomerCreditEgp)
      .toBe(overview.totalCashInEgp);
  });
});
