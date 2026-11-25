import { describe, expect, it } from "vitest";
import { aggregateProjectCostTotals, computeProjectCostProfile, withAllocatedOverhead } from "../src/calc/costs";

describe("Milestone 6 cost views", () => {
  it("keeps paid, accrued, committed, forecast, and cash concepts separate", () => {
    const row = computeProjectCostProfile({ projectId: 1, recognizedRevenueReporting: 1_000_000,
      forecastRevenueReporting: 2_000_000, actualCashInReporting: 700_000, actualPaidCostReporting: 300_000,
      accruedCostReporting: 200_000, committedCostReporting: 800_000 });
    expect(row.forecastCostReporting).toBe(800_000);
    expect(row.actualProfitReporting).toBe(500_000);
    expect(row.cashProfitReporting).toBe(400_000);
    expect(row.committedProfitReporting).toBe(1_200_000);
    expect(row.forecastProfitReporting).toBe(1_200_000);
  });

  it("forecast cost cannot be below paid plus accrued", () => {
    const row = computeProjectCostProfile({ projectId: 1, recognizedRevenueReporting: 500_000,
      forecastRevenueReporting: 900_000, actualCashInReporting: 300_000, actualPaidCostReporting: 400_000,
      accruedCostReporting: 200_000, committedCostReporting: 450_000 });
    expect(row.forecastCostReporting).toBe(600_000);
    expect(row.forecastProfitReporting).toBe(300_000);
  });

  it("allocated overhead increases paid and committed costs without changing cash-in", () => {
    const base = computeProjectCostProfile({ projectId: 1, recognizedRevenueReporting: 1_000_000,
      forecastRevenueReporting: 2_000_000, actualCashInReporting: 700_000, actualPaidCostReporting: 300_000,
      accruedCostReporting: 100_000, committedCostReporting: 800_000 });
    const row = withAllocatedOverhead(base, 50_000);
    expect(base.actualPaidCostReporting).toBe(300_000);
    expect(base.actualProfitReporting).toBe(600_000);
    expect(row.actualPaidCostReporting).toBe(350_000);
    expect(row.committedCostReporting).toBe(850_000);
    expect(row.actualProfitReporting).toBe(550_000);
    expect(row.cashProfitReporting).toBe(350_000);
  });

  it("aggregates each project forecast instead of netting unrelated project risks", () => {
    const incurredHeavy = computeProjectCostProfile({ projectId: 1, recognizedRevenueReporting: 0,
      forecastRevenueReporting: 1_000_000, actualCashInReporting: 0, actualPaidCostReporting: 400_000,
      accruedCostReporting: 100_000, committedCostReporting: 200_000 });
    const commitmentHeavy = computeProjectCostProfile({ projectId: 2, recognizedRevenueReporting: 0,
      forecastRevenueReporting: 1_000_000, actualCashInReporting: 0, actualPaidCostReporting: 100_000,
      accruedCostReporting: 0, committedCostReporting: 600_000 });
    const totals = aggregateProjectCostTotals([incurredHeavy, commitmentHeavy], 50_000);
    expect(totals.actualPaidCostReporting).toBe(550_000);
    expect(totals.committedCostReporting).toBe(850_000);
    expect(totals.forecastCostReporting).toBe(1_150_000);
  });
});
