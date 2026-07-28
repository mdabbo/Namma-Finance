import { describe, expect, it } from "vitest";
import type { Expense, ProjectFinancials } from "../src";
import {
  buildMonthlyCashSeries,
  computeDashboardAttention,
  computeDashboardOverview,
  resolveEffectiveFxSnapshot,
} from "../src";

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
  it("derives the four headline facts from EGP core aggregates", () => {
    const projects = [
      {
        contractValueEgp: 10_000_00,
        totalActualCashInEgp: 6_000_00,
        outstandingEgp: 3_000_00,
        unallocatedCustomerCreditEgp: 500_00,
      },
      {
        contractValueEgp: 20_000_00,
        totalActualCashInEgp: 4_000_00,
        outstandingEgp: 8_000_00,
        unallocatedCustomerCreditEgp: 0,
      },
    ] as ProjectFinancials[];
    expect(computeDashboardOverview(projects, [
      expense(1_000_00),
      expense(100_00, "USD", 50_000_000),
    ])).toEqual({
      contractValueEgp: 30_000_00,
      cashCollectedEgp: 10_000_00,
      outstandingReceivablesEgp: 11_000_00,
      cashOutEgp: 6_000_00,
      netCashPositionEgp: 4_000_00,
      unallocatedCustomerCreditEgp: 500_00,
    });
  });

  it("uses stored row FX in monthly cash without floating-point money", () => {
    expect(buildMonthlyCashSeries(
      [{ date: "2026-05-03", egpMinor: 6_000_00 }],
      [expense(100_00, "USD", 50_000_000)],
    )).toEqual([{
      month: "2026-05",
      cashInEgp: 6_000_00,
      cashOutEgp: 5_000_00,
      netEgp: 1_000_00,
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
      projects: [{ unallocatedCustomerCreditEgp: 50_00 } as ProjectFinancials],
      readyToInvoiceEgp: [25_00, 75_00],
      teamPaymentsDueEgp: [40_00],
    });
    expect(summary).toEqual({
      overdueCertificates: { count: 1, amountEgp: 100_00 },
      readyToInvoice: { count: 2, amountEgp: 100_00 },
      unallocatedPayments: { count: 1, amountEgp: 50_00 },
      teamPaymentsDue: { count: 1, amountEgp: 40_00 },
    });
  });
});
