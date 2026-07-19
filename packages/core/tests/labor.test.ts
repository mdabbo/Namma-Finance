import { describe, expect, it } from "vitest";
import { computeCosting, laborCostMinor, minutesToHours } from "../src/calc/labor";
import type { ProjectProfitability } from "../src/calc/profitability";

describe("laborCostMinor", () => {
  it("computes minutes × hourly rate ÷ 60 exactly", () => {
    // 90 min at 100.00/hr (10,000 minor) = 150.00 → 15,000
    expect(laborCostMinor(90, 10_000)).toBe(15_000);
    // a full hour = the rate
    expect(laborCostMinor(60, 10_000)).toBe(10_000);
    // 8 hours
    expect(laborCostMinor(480, 12_500)).toBe(100_000);
  });

  it("rounds fractional minor units half-up", () => {
    // 25 min at 100.00/hr = 41.6667 → 41.67 (4167 minor)
    expect(laborCostMinor(25, 10_000)).toBe(4_167);
    // 10 min at 90.00/hr (9000) = 15.00 → 1500
    expect(laborCostMinor(10, 9_000)).toBe(1_500);
  });

  it("is zero when the person has no rate or no time", () => {
    expect(laborCostMinor(120, null)).toBe(0);
    expect(laborCostMinor(120, 0)).toBe(0);
    expect(laborCostMinor(0, 10_000)).toBe(0);
  });
});

describe("computeCosting", () => {
  const rows: ProjectProfitability[] = [
    {
      projectId: 1, projectCode: "P1", projectName: "One",
      revenueEgp: 1_000_000, directCostEgp: 200_000, grossProfitEgp: 800_000, grossMarginBp: 8000,
      overheadEgp: 100_000, netProfitEgp: 700_000, netMarginBp: 7000,
    },
  ];

  it("adds labor to get true cost and fully-loaded profit, leaving cash net profit intact", () => {
    const costing = computeCosting(rows, new Map([[1, 300_000]]));
    expect(costing[0]!.laborCostEgp).toBe(300_000);
    // true cost = 200,000 direct + 300,000 labor + 100,000 overhead
    expect(costing[0]!.trueCostEgp).toBe(600_000);
    // fully loaded = 1,000,000 − 600,000
    expect(costing[0]!.fullyLoadedProfitEgp).toBe(400_000);
    expect(costing[0]!.fullyLoadedMarginBp).toBe(4000);
    // cash figures pass through untouched (no double count)
    expect(costing[0]!.netProfitEgp).toBe(700_000);
  });

  it("defaults labor to zero for projects with no logged time", () => {
    const costing = computeCosting(rows, new Map());
    expect(costing[0]!.laborCostEgp).toBe(0);
    expect(costing[0]!.fullyLoadedProfitEgp).toBe(700_000); // = net profit when no labor
  });
});

describe("minutesToHours", () => {
  it("converts for display", () => {
    expect(minutesToHours(90)).toBe(1.5);
    expect(minutesToHours(75)).toBe(1.25);
    expect(minutesToHours(60)).toBe(1);
  });
});
