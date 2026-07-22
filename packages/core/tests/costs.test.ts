import { describe, expect, it } from "vitest";
import { aggregateProjectCostTotals, computeProjectCostProfile, withAllocatedOverhead } from "../src/calc/costs";

describe("Milestone 6 cost views", () => {
  it("keeps paid, accrued, committed, forecast, and cash concepts separate", () => {
    const row = computeProjectCostProfile({ projectId: 1, recognizedRevenueEgp: 1_000_000,
      forecastRevenueEgp: 2_000_000, actualCashInEgp: 700_000, actualPaidCostEgp: 300_000,
      accruedCostEgp: 200_000, committedCostEgp: 800_000 });
    expect(row.forecastCostEgp).toBe(800_000);
    expect(row.actualProfitEgp).toBe(500_000);
    expect(row.cashProfitEgp).toBe(400_000);
    expect(row.committedProfitEgp).toBe(1_200_000);
    expect(row.forecastProfitEgp).toBe(1_200_000);
  });

  it("forecast cost cannot be below paid plus accrued", () => {
    const row = computeProjectCostProfile({ projectId: 1, recognizedRevenueEgp: 500_000,
      forecastRevenueEgp: 900_000, actualCashInEgp: 300_000, actualPaidCostEgp: 400_000,
      accruedCostEgp: 200_000, committedCostEgp: 450_000 });
    expect(row.forecastCostEgp).toBe(600_000);
    expect(row.forecastProfitEgp).toBe(300_000);
  });

  it("allocated overhead increases paid and committed costs without changing cash-in", () => {
    const base = computeProjectCostProfile({ projectId: 1, recognizedRevenueEgp: 1_000_000,
      forecastRevenueEgp: 2_000_000, actualCashInEgp: 700_000, actualPaidCostEgp: 300_000,
      accruedCostEgp: 100_000, committedCostEgp: 800_000 });
    const row = withAllocatedOverhead(base, 50_000);
    expect(base.actualPaidCostEgp).toBe(300_000);
    expect(base.actualProfitEgp).toBe(600_000);
    expect(row.actualPaidCostEgp).toBe(350_000);
    expect(row.committedCostEgp).toBe(850_000);
    expect(row.actualProfitEgp).toBe(550_000);
    expect(row.cashProfitEgp).toBe(350_000);
  });

  it("aggregates each project forecast instead of netting unrelated project risks", () => {
    const incurredHeavy = computeProjectCostProfile({ projectId: 1, recognizedRevenueEgp: 0,
      forecastRevenueEgp: 1_000_000, actualCashInEgp: 0, actualPaidCostEgp: 400_000,
      accruedCostEgp: 100_000, committedCostEgp: 200_000 });
    const commitmentHeavy = computeProjectCostProfile({ projectId: 2, recognizedRevenueEgp: 0,
      forecastRevenueEgp: 1_000_000, actualCashInEgp: 0, actualPaidCostEgp: 100_000,
      accruedCostEgp: 0, committedCostEgp: 600_000 });
    const totals = aggregateProjectCostTotals([incurredHeavy, commitmentHeavy], 50_000);
    expect(totals.actualPaidCostEgp).toBe(550_000);
    expect(totals.committedCostEgp).toBe(850_000);
    expect(totals.forecastCostEgp).toBe(1_150_000);
  });
});
