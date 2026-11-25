import { describe, expect, it } from "vitest";
import type { Expense, FinanceContractInput, ProjectFinancials } from "../src";
import {
  buildMonthlyCashSeries,
  computeDashboardAttention,
  computeDashboardOverview,
  dashboardCashInComponentsReconcile,
  resolveEffectiveFxSnapshot,
  selectOpenReceivables,
  selectUpcomingCollections,
} from "../src";
import { EGP_VALUATION } from "../src/money/currencyValuation";

const expense = (
  amountMinor: number,
  currency = "EGP",
  fxRateMicro = 1_000_000,
  date = "2026-05-01",
): Expense => ({
  id: 1,
  date,
  categoryId: 1,
  description: "Expense",
  projectId: null,
  supplier: null,
  amountMinor,
  currency,
  fxRateMicro,
  attachmentPath: null,
  createdAt: date,
});

describe("dashboard financial model", () => {
  it("derives the headline facts from EGP core aggregates", () => {
    const projects = [
      {
        contractValueReporting: 10_000_00,
        totalActualCashInReporting: 6_000_00,
        certificateCollectionsReporting: 3_500_00,
        advanceReceivedReporting: 1_500_00,
        retentionReleasedReporting: 500_00,
        outstandingReporting: 3_000_00,
        unallocatedCustomerCreditReporting: 500_00,
      },
      {
        contractValueReporting: 20_000_00,
        totalActualCashInReporting: 4_000_00,
        certificateCollectionsReporting: 4_000_00,
        advanceReceivedReporting: 0,
        retentionReleasedReporting: 0,
        outstandingReporting: 8_000_00,
        unallocatedCustomerCreditReporting: 0,
      },
    ] as ProjectFinancials[];
    expect(computeDashboardOverview(projects, [
      expense(1_000_00),
      expense(100_00, "USD", 50_000_000),
    ], EGP_VALUATION)).toEqual({
      contractValueReporting: 30_000_00,
      totalCashInReporting: 10_000_00,
      certificateCollectionsReporting: 7_500_00,
      advanceReceivedReporting: 1_500_00,
      retentionReleasedReporting: 500_00,
      unallocatedCustomerCreditReporting: 500_00,
      outstandingReceivablesReporting: 11_000_00,
      cashOutReporting: 6_000_00,
      netCashPositionReporting: 4_000_00,
    });
  });

  /**
   * The headline is total cash in, not collections. Certificate collections are
   * only one part of it, so the label must never be read as "collected".
   */
  it("keeps the headline total apart from certificate collections", () => {
    const projects = [
      {
        contractValueReporting: 10_000_00,
        totalActualCashInReporting: 6_000_00,
        certificateCollectionsReporting: 1_000_00,
        advanceReceivedReporting: 4_000_00,
        retentionReleasedReporting: 600_00,
        outstandingReporting: 0,
        unallocatedCustomerCreditReporting: 400_00,
      },
    ] as ProjectFinancials[];
    const overview = computeDashboardOverview(projects, [], EGP_VALUATION);

    expect(overview.totalCashInReporting).toBe(6_000_00);
    expect(overview.certificateCollectionsReporting).toBe(1_000_00);
    expect(overview.certificateCollectionsReporting).not.toBe(overview.totalCashInReporting);
    // Components account for the total exactly — nothing lost, nothing counted twice.
    expect(dashboardCashInComponentsReconcile(overview)).toBe(true);
    // Net cash position stays total actual cash in less actual cash out.
    expect(computeDashboardOverview(projects, [expense(2_500_00)], EGP_VALUATION).netCashPositionReporting)
      .toBe(6_000_00 - 2_500_00);
  });

  it("uses stored row FX in monthly cash without floating-point money", () => {
    expect(buildMonthlyCashSeries(
      [{ date: "2026-05-03", egpMinor: 6_000_00 }],
      [expense(100_00, "USD", 50_000_000)],
      EGP_VALUATION,
    )).toEqual([{
      month: "2026-05",
      cashInReporting: 6_000_00,
      cashOutReporting: 5_000_00,
      netReporting: 1_000_00,
    }]);
  });

  it("selects the historical FX revision effective on the record date", () => {
    const revisions = [
      { revisionNumber: 1, effectiveDate: "2026-01-01", currency: "EGP", fxRateMicro: 1_000_000 },
      { revisionNumber: 2, effectiveDate: "2026-03-01", currency: "USD", fxRateMicro: 50_000_000 },
    ];
    expect(resolveEffectiveFxSnapshot(revisions, "2026-02-15", {
      currency: "USD",
      fxRateMicro: 55_000_000,
    })).toEqual({ currency: "EGP", fxRateMicro: 1_000_000 });
    expect(resolveEffectiveFxSnapshot(revisions, "2026-04-01", {
      currency: "USD",
      fxRateMicro: 55_000_000,
    })).toEqual({ currency: "USD", fxRateMicro: 50_000_000 });
  });

  it("values overdue attention at each certificate's historical FX", () => {
    const summary = computeDashboardAttention({
      contracts: [{
        projectCurrency: "USD",
        projectFxRateMicro: 50_000_000,
        state: {
          unallocatedCustomerCreditMinor: 50_00,
          certificates: [{
            overdue: true,
            unpaidMinor: 100_00,
            certificate: {
              currencySnapshot: "EGP",
              fxRateMicroSnapshot: 1_000_000,
            },
          }],
        },
      } as never],
      projects: [{ unallocatedCustomerCreditReporting: 50_00 } as ProjectFinancials],
      readyToInvoiceReporting: [25_00, 75_00],
      teamPaymentsDueReporting: [40_00],
    }, EGP_VALUATION);
    expect(summary).toEqual({
      overdueCertificates: { count: 1, amountReporting: 100_00 },
      readyToInvoice: { count: 2, amountReporting: 100_00 },
      unallocatedPayments: { count: 1, amountReporting: 50_00 },
      teamPaymentsDue: { count: 1, amountReporting: 40_00 },
    });
  });

  const receivableFixture = (): FinanceContractInput[] => [{
    projectCurrency: "USD",
    projectFxRateMicro: 50_000_000,
    state: {
      contract: { id: 9, number: "C-9", projectId: 4 },
      certificates: [
        {
          overdue: true,
          unpaidMinor: 100_00,
          dueDate: "2026-05-01",
          certificate: {
            id: 1, number: "PC-1", status: "APPROVED",
            currencySnapshot: "EGP", fxRateMicroSnapshot: 1_000_000,
          },
        },
        {
          overdue: false,
          unpaidMinor: 200_00,
          dueDate: "2026-08-10",
          certificate: {
            id: 2, number: "PC-2", status: "SUBMITTED",
            currencySnapshot: null, fxRateMicroSnapshot: null,
          },
        },
        // Fully collected and draft certificates are never receivables.
        {
          overdue: false,
          unpaidMinor: 0,
          dueDate: "2026-08-01",
          certificate: { id: 3, number: "PC-3", status: "PAID" },
        },
        {
          overdue: false,
          unpaidMinor: 300_00,
          dueDate: null,
          certificate: { id: 4, number: "PC-4", status: "DRAFT" },
        },
      ],
    },
  } as never];

  it("selects billable unpaid certificates at their historical FX as receivables", () => {
    const receivables = selectOpenReceivables(receivableFixture(), EGP_VALUATION);
    expect(receivables.map((row) => row.certificateId)).toEqual([1, 2]);
    expect(receivables[0]).toMatchObject({
      certificateNumber: "PC-1",
      contractNumber: "C-9",
      projectId: 4,
      overdue: true,
      currency: "EGP",
      unpaidMinor: 100_00,
      unpaidReporting: 100_00,
    });
    // Fallback to the project FX snapshot when the certificate has none.
    expect(receivables[1]).toMatchObject({ currency: "USD", unpaidReporting: 10_000_00 });
  });

  it("forecasts upcoming collections inside the horizon without double-counting overdue", () => {
    const receivables = selectOpenReceivables(receivableFixture(), EGP_VALUATION);
    const upcoming = selectUpcomingCollections(receivables, "2026-07-01", 60);
    expect(upcoming.horizonEndIso).toBe("2026-08-30");
    expect(upcoming.items.map((row) => row.certificateId)).toEqual([2]);
    expect(upcoming.totalReporting).toBe(10_000_00);

    const shortHorizon = selectUpcomingCollections(receivables, "2026-07-01", 7);
    expect(shortHorizon.items).toEqual([]);
    expect(shortHorizon.totalReporting).toBe(0);
  });
});
