import { describe, expect, it } from "vitest";
import {
  certificateSectionKpis,
  expenseSectionKpis,
  financeContractInputs,
  inProjectScope,
  parseFinanceScope,
  paymentSectionKpis,
  type ProjectMoneyFacts,
} from "../src/features/finance/financeSectionModel";

function projectFacts(overrides: Partial<ProjectMoneyFacts> & { id: number }): ProjectMoneyFacts {
  return {
    project: { id: overrides.id },
    invoicedAmountEgp: 0,
    outstandingEgp: 0,
    overdueCertificates: 0,
    totalActualCashInEgp: 0,
    unallocatedCustomerCreditEgp: 0,
    ...overrides,
  };
}

describe("Milestone 5 finance section", () => {
  it("accepts only the attention views each list understands", () => {
    expect(parseFinanceScope(new URLSearchParams("view=overdue"), "certificates").view).toBe("overdue");
    expect(parseFinanceScope(new URLSearchParams("view=unallocated"), "certificates").view).toBeNull();
    expect(parseFinanceScope(new URLSearchParams("view=unallocated"), "payments").view).toBe("unallocated");
    expect(parseFinanceScope(new URLSearchParams("view=overdue"), "expenses").view).toBeNull();
    expect(parseFinanceScope(new URLSearchParams("view=overdue"), "receivables").view).toBe("overdue");
    expect(parseFinanceScope(new URLSearchParams("view=DROP%20TABLE"), "payments").view).toBeNull();
  });

  it("pairs contract states with their project FX context and drops orphans", () => {
    const states = new Map([
      [1, { contract: { projectId: 4 } }],
      [2, { contract: { projectId: 99 } }],
    ]) as never;
    const inputs = financeContractInputs({
      contractStates: states,
      projects: [{ project: { id: 4, currency: "USD", fxRateMicro: 50_000_000 } }],
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ projectCurrency: "USD", projectFxRateMicro: 50_000_000 });
  });

  it("degrades an invalid projectId to the unfiltered list instead of filtering to nothing", () => {
    expect(parseFinanceScope(new URLSearchParams("projectId=7"), "certificates").projectId).toBe(7);
    for (const raw of ["0", "-3", "1.5", "abc", "1e3", "9007199254740993", ""]) {
      expect(
        parseFinanceScope(new URLSearchParams(`projectId=${raw}`), "certificates").projectId,
        `projectId=${raw}`,
      ).toBeNull();
    }
    expect(parseFinanceScope(new URLSearchParams(), "certificates")).toEqual({ view: null, projectId: null });
  });

  it("keeps overhead rows visible only when no project scope is active", () => {
    expect(inProjectScope(null, null)).toBe(true);
    expect(inProjectScope(4, null)).toBe(true);
    expect(inProjectScope(4, 4)).toBe(true);
    expect(inProjectScope(null, 4)).toBe(false);
    expect(inProjectScope(5, 4)).toBe(false);
  });

  it("sums certificate KPIs from read-model figures without recalculating money", () => {
    const projects = [
      projectFacts({ id: 1, invoicedAmountEgp: 100, outstandingEgp: 40, overdueCertificates: 2 }),
      projectFacts({ id: 2, invoicedAmountEgp: 50, outstandingEgp: 0, overdueCertificates: 0 }),
    ];
    expect(certificateSectionKpis(projects, null)).toEqual({
      invoicedEgp: 150,
      outstandingEgp: 40,
      overdueCount: 2,
    });
    expect(certificateSectionKpis(projects, 2)).toEqual({
      invoicedEgp: 50,
      outstandingEgp: 0,
      overdueCount: 0,
    });
  });

  it("buckets collected cash into the current month per project scope", () => {
    const kpis = paymentSectionKpis({
      projects: [
        projectFacts({ id: 1, totalActualCashInEgp: 900, unallocatedCustomerCreditEgp: 30 }),
        projectFacts({ id: 2, totalActualCashInEgp: 100, unallocatedCustomerCreditEgp: 0 }),
      ],
      cashIn: [
        { date: "2026-07-03", projectId: 1, egpMinor: 500 },
        { date: "2026-07-28", projectId: 2, egpMinor: 100 },
        { date: "2026-06-30", projectId: 1, egpMinor: 400 },
      ],
      projectId: null,
      todayIso: "2026-07-28",
    });
    expect(kpis).toEqual({ totalCashInEgp: 1000, monthCashInEgp: 600, unallocatedCreditEgp: 30 });

    const scopedKpis = paymentSectionKpis({
      projects: [projectFacts({ id: 1, totalActualCashInEgp: 900, unallocatedCustomerCreditEgp: 30 })],
      cashIn: [
        { date: "2026-07-03", projectId: 1, egpMinor: 500 },
        { date: "2026-07-28", projectId: 2, egpMinor: 100 },
      ],
      projectId: 1,
      todayIso: "2026-07-28",
    });
    expect(scopedKpis).toEqual({ totalCashInEgp: 900, monthCashInEgp: 500, unallocatedCreditEgp: 30 });
  });

  it("splits expense KPIs into overhead and project spend consolidated in EGP", () => {
    const expenses = [
      { date: "2026-07-10", projectId: 3, amountMinor: 10_000, currency: "EGP", fxRateMicro: 1_000_000 },
      { date: "2026-07-11", projectId: null, amountMinor: 100_00, currency: "USD", fxRateMicro: 50_000_000 },
      { date: "2026-05-01", projectId: 3, amountMinor: 2_000, currency: "EGP", fxRateMicro: 1_000_000 },
    ];
    expect(expenseSectionKpis(expenses, null, "2026-07-28")).toEqual({
      totalEgp: 10_000 + 500_000 + 2_000,
      monthEgp: 10_000 + 500_000,
      overheadEgp: 500_000,
      projectEgp: 12_000,
    });
    // Project scope: overhead rows drop out entirely.
    expect(expenseSectionKpis(expenses, 3, "2026-07-28")).toEqual({
      totalEgp: 12_000,
      monthEgp: 10_000,
      overheadEgp: 0,
      projectEgp: 12_000,
    });
  });
});
