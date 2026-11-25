import { describe, expect, it } from "vitest";
import { allocateOverhead } from "../src/calc/overhead";
import { computeProfitability } from "../src/calc/profitability";
import { buildCashflow } from "../src/calc/cashflow";
import { bucketFor, computeAging } from "../src/calc/aging";
import type { ProjectFinancials } from "../src/calc/aggregate";
import type { Project } from "../src/domain/types";

const TODAY = "2026-07-16";

function fin(over: {
  id: number;
  revenueReporting: number;
  expensesReporting: number;
  status?: Project["status"];
}): ProjectFinancials {
  return {
    project: {
      id: over.id, code: `PRJ-2026-00${over.id}`, name: `P${over.id}`, clientId: 1,
      country: null, city: null, manager: null, discipline: "MULTI",
      projectType: null, status: over.status ?? "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000,
      startDate: null, endDate: null, progressBp: 0, description: null, createdAt: "",
    },
    contracts: [],
    contractValueMinor: 0, certifiedBaseMinor: 0, billableRevenueMinor: 0, invoicedAmountMinor: 0,
    totalDueMinor: 0, totalPaidMinor: 0, certificateCollectionsMinor: 0,
    advanceReceivedMinor: 0, retentionReleasedMinor: 0, totalActualCashInMinor: 0,
    unallocatedCustomerCreditMinor: 0, outstandingMinor: 0, outstandingReceivablesMinor: 0,
    remainingUncertifiedMinor: 0, retentionHeldMinor: 0, certifiedRatioBp: 0, collectionRatioBp: 0,
    contractValueReporting: 0,
    revenueReporting: over.revenueReporting,
    billableRevenueReporting: 0, invoicedAmountReporting: 0, collectedReporting: 0,
    certificateCollectionsReporting: 0, advanceReceivedReporting: 0, retentionReleasedReporting: 0,
    totalActualCashInReporting: 0, unallocatedCustomerCreditReporting: 0, outstandingReporting: 0,
    expensesReporting: over.expensesReporting,
    profitReporting: over.revenueReporting - over.expensesReporting,
    marginBp: 0, overdueCertificates: 0,
  };
}

describe("overhead allocation", () => {
  const projects = [
    { projectId: 1, revenueReporting: 600, directCostReporting: 100, isActive: true },
    { projectId: 2, revenueReporting: 300, directCostReporting: 300, isActive: true },
    { projectId: 3, revenueReporting: 100, directCostReporting: 0, isActive: false },
  ];

  it("splits by revenue share and sums exactly", () => {
    const shares = allocateOverhead(1000, projects, "REVENUE");
    expect(shares.get(1)).toBe(600);
    expect(shares.get(2)).toBe(300);
    expect(shares.get(3)).toBe(100);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("splits by direct cost", () => {
    const shares = allocateOverhead(1000, projects, "DIRECT_COST");
    expect(shares.get(1)).toBe(250);
    expect(shares.get(2)).toBe(750);
    expect(shares.get(3)).toBe(0);
  });

  it("splits evenly over ACTIVE projects only", () => {
    const shares = allocateOverhead(1001, projects, "EVEN");
    expect(shares.get(3)).toBe(0);
    expect((shares.get(1) ?? 0) + (shares.get(2) ?? 0)).toBe(1001);
  });

  it("falls back to even split when the basis is all zero", () => {
    const zeroRevenue = [
      { projectId: 1, revenueReporting: 0, directCostReporting: 0, isActive: true },
      { projectId: 2, revenueReporting: 0, directCostReporting: 0, isActive: true },
    ];
    const shares = allocateOverhead(100, zeroRevenue, "REVENUE");
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("handles no projects", () => {
    expect(allocateOverhead(100, [], "REVENUE").size).toBe(0);
  });
});

describe("profitability with allocated overhead", () => {
  it("computes gross/net and ranks by net profit", () => {
    const rows = computeProfitability(
      [fin({ id: 1, revenueReporting: 1000, expensesReporting: 300 }), fin({ id: 2, revenueReporting: 500, expensesReporting: 450 })],
      300, // overhead: revenue share → 200 / 100
      "REVENUE",
    );
    expect(rows[0]!.projectId).toBe(1);
    expect(rows[0]!.grossProfitReporting).toBe(700);
    expect(rows[0]!.overheadReporting).toBe(200);
    expect(rows[0]!.netProfitReporting).toBe(500);
    expect(rows[0]!.netMarginBp).toBe(5000);
    expect(rows[1]!.netProfitReporting).toBe(500 - 450 - 100);
  });

  it("net profits + overhead reconcile with office totals", () => {
    const projects = [fin({ id: 1, revenueReporting: 777, expensesReporting: 123 }), fin({ id: 2, revenueReporting: 333, expensesReporting: 55 })];
    const rows = computeProfitability(projects, 217, "REVENUE");
    const totalNet = rows.reduce((s, r) => s + r.netProfitReporting, 0);
    expect(totalNet).toBe(777 - 123 + 333 - 55 - 217);
  });
});

describe("cash-flow series with forecast", () => {
  it("buckets actuals by month and forecasts receivables + recurring", () => {
    const rows = buildCashflow({
      actualIn: [{ date: "2026-06-10", egpMinor: 500 }, { date: "2026-07-01", egpMinor: 200 }],
      actualOut: [{ date: "2026-06-15", egpMinor: 300 }],
      openReceivables: [
        { dueDate: "2026-08-15", unpaidReporting: 1000 }, // future month
        { dueDate: "2026-05-01", unpaidReporting: 400 },  // overdue → current month
        { dueDate: null, unpaidReporting: 50 },           // unscheduled → current month
      ],
      recurring: [{ egpMinor: 100, dayOfMonth: 1 }],
      todayIso: TODAY,
      monthsBack: 1,
      monthsForward: 2,
    });
    expect(rows.map((r) => r.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(rows[0]).toMatchObject({ inActual: 500, outActual: 300, inForecast: 0, isForecast: false });
    expect(rows[1]).toMatchObject({ inActual: 200, inForecast: 450, isForecast: false }); // overdue+unscheduled
    expect(rows[2]).toMatchObject({ inForecast: 1000, outForecast: 100, isForecast: true });
    expect(rows[3]).toMatchObject({ outForecast: 100 });
  });

  it("cumulative is a running total of net", () => {
    const rows = buildCashflow({
      actualIn: [{ date: "2026-07-01", egpMinor: 100 }],
      actualOut: [],
      openReceivables: [],
      recurring: [{ egpMinor: 40, dayOfMonth: 5 }],
      todayIso: TODAY,
      monthsBack: 0,
      monthsForward: 2,
    });
    expect(rows.map((r) => r.net)).toEqual([100, -40, -40]);
    expect(rows.map((r) => r.cumulative)).toEqual([100, 60, 20]);
  });

  it("crosses year boundaries", () => {
    const rows = buildCashflow({
      actualIn: [], actualOut: [], openReceivables: [], recurring: [],
      todayIso: "2026-12-10", monthsBack: 1, monthsForward: 2,
    });
    expect(rows.map((r) => r.month)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
});

describe("receivables aging", () => {
  it("buckets by days overdue", () => {
    expect(bucketFor(0)).toBe("CURRENT");
    expect(bucketFor(-5)).toBe("CURRENT");
    expect(bucketFor(1)).toBe("D1_30");
    expect(bucketFor(30)).toBe("D1_30");
    expect(bucketFor(31)).toBe("D31_60");
    expect(bucketFor(60)).toBe("D31_60");
    expect(bucketFor(61)).toBe("D61_90");
    expect(bucketFor(91)).toBe("D90_PLUS");
  });

  it("totals buckets and sorts most-overdue first", () => {
    const summary = computeAging(
      [
        { certificateId: 1, certificateNumber: "PC-1", projectName: "P", clientName: "C", dueDate: "2026-07-01", unpaidReporting: 100 }, // 15 days
        { certificateId: 2, certificateNumber: "PC-2", projectName: "P", clientName: "C", dueDate: "2026-03-01", unpaidReporting: 200 }, // 137 days
        { certificateId: 3, certificateNumber: "PC-3", projectName: "P", clientName: "C", dueDate: "2026-08-01", unpaidReporting: 300 }, // future
        { certificateId: 4, certificateNumber: "PC-4", projectName: "P", clientName: "C", dueDate: null, unpaidReporting: 50 },
        { certificateId: 5, certificateNumber: "PC-5", projectName: "P", clientName: "C", dueDate: "2026-01-01", unpaidReporting: 0 }, // settled → excluded
      ],
      TODAY,
    );
    expect(summary.rows[0]!.certificateId).toBe(2);
    expect(summary.totals.CURRENT).toBe(350);
    expect(summary.totals.D1_30).toBe(100);
    expect(summary.totals.D90_PLUS).toBe(200);
    expect(summary.grandTotal).toBe(650);
    expect(summary.rows).toHaveLength(4);
  });
});
