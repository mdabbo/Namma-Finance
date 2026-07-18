import { describe, expect, it } from "vitest";
import { advanceShareBp, milestoneAmounts as ma, milestonesAreComplete as mac } from "../src/calc/valuation";

describe("payment-schedule style plans (advance + milestones = 100%)", () => {
  const plan = [
    { title: "M1", percentBp: 2000 },
    { title: "M2", percentBp: 2000 },
    { title: "M3", percentBp: 2000 },
  ];

  it("advance share derives from contract terms", () => {
    expect(advanceShareBp({ valueMinor: 3_500_000, advanceMinor: 1_400_000 })).toBe(4000);
    expect(advanceShareBp({ valueMinor: 3_500_000, advanceMinor: 0 })).toBe(0);
    expect(advanceShareBp({ valueMinor: 0, advanceMinor: 100 })).toBe(0);
  });

  it("milestones totaling 100% − advance% are a complete plan", () => {
    expect(mac(plan, 4000)).toBe(true);
    expect(mac(plan, 0)).toBe(false); // without an advance, 60% is incomplete
  });

  it("legacy plans totaling 100% stay complete with or without advance", () => {
    const legacy = [{ title: "A", percentBp: 6000 }, { title: "B", percentBp: 4000 }];
    expect(mac(legacy, 0)).toBe(true);
    expect(mac(legacy, 4000)).toBe(true);
  });

  it("certificate bases of a payment-style plan cover the FULL value", () => {
    // 35,000 contract, 40% advance, milestones 20/20/20:
    // each certificate base = 35,000/3 — recovery brings its net to 7,000
    const amounts = ma(3_500_000, plan, 4000);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(3_500_000);
    expect(amounts[0]).toBeGreaterThan(1_166_000);
  });
});
import { fromEgpPiasters, toEgpPiasters } from "../src/money";
import {
  computeReadyToBill,
  drawingsValueMinor,
  isMilestoneAchieved,
  milestoneAmounts,
  milestonesAreComplete,
  milestonesTotalBp,
  parseDrawings,
  parseMilestones,
} from "../src/calc/valuation";

describe("base-currency conversion (fromEgpPiasters)", () => {
  it("EGP passes through unchanged", () => {
    expect(fromEgpPiasters(123_456, "EGP", 1_000_000)).toBe(123_456);
  });

  it("converts EGP piasters to USD cents at the stored rate", () => {
    // 4,825.00 EGP at 48.25 EGP/USD = 100.00 USD
    expect(fromEgpPiasters(482_500, "USD", 48_250_000)).toBe(10_000);
  });

  it("converts to SAR at the stored rate", () => {
    // 1,290.00 EGP at 12.90 EGP/SAR = 100.00 SAR
    expect(fromEgpPiasters(129_000, "SAR", 12_900_000)).toBe(10_000);
  });

  it("round-trips with toEgpPiasters within rounding tolerance", () => {
    const usdCents = 123_456_789;
    const egp = toEgpPiasters(usdCents, "USD", 48_250_000);
    const back = fromEgpPiasters(egp, "USD", 48_250_000);
    expect(Math.abs(back - usdCents)).toBeLessThanOrEqual(1);
  });

  it("rejects non-positive rates", () => {
    expect(() => fromEgpPiasters(100, "USD", 0)).toThrow(RangeError);
  });
});

describe("milestone (%) valuation", () => {
  const plan = [
    { title: "Concept", percentBp: 1000 },
    { title: "30%", percentBp: 2000 },
    { title: "60%", percentBp: 2000 },
    { title: "90%", percentBp: 2500 },
    { title: "IFC", percentBp: 2500 },
  ];

  it("recognises a complete 100% plan", () => {
    expect(milestonesTotalBp(plan)).toBe(10_000);
    expect(milestonesAreComplete(plan)).toBe(true);
  });

  it("complete plans allocate amounts summing EXACTLY to the contract value", () => {
    // A value that does not divide evenly: 1,000,001 piasters
    const amounts = milestoneAmounts(1_000_001, plan);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(1_000_001);
    expect(amounts).toHaveLength(5);
  });

  it("partial plans compute value × percent per milestone", () => {
    const partial = [{ title: "Concept", percentBp: 1000 }];
    expect(milestonesAreComplete(partial)).toBe(false);
    expect(milestoneAmounts(10_000_000, partial)).toEqual([1_000_000]);
  });

  it("parses valid JSON and rejects malformed entries", () => {
    const parsed = parseMilestones(JSON.stringify([...plan, { bad: true }, { title: "neg", percentBp: -5 }]));
    expect(parsed).toHaveLength(5);
    expect(parseMilestones("not json")).toEqual([]);
    expect(parseMilestones(null)).toEqual([]);
  });
});

describe("milestone achievement → ready to bill", () => {
  const plan = [
    { title: "Concept", percentBp: 2000, stageId: 11 },
    { title: "60%", percentBp: 3000, stageId: 12 },
    { title: "IFC", percentBp: 5000, done: true }, // manually achieved, no stage link
  ];
  const value = 10_000_000; // 100,000.00

  it("counts linked-stage completion and manual checkmarks as achieved", () => {
    expect(isMilestoneAchieved(plan[0]!, new Set([11]))).toBe(true);
    expect(isMilestoneAchieved(plan[0]!, new Set())).toBe(false);
    expect(isMilestoneAchieved(plan[2]!, new Set())).toBe(true);

    const ready = computeReadyToBill(value, plan, new Set([11]), 0);
    // Concept (20%) + IFC (50%) achieved = 70,000.00
    expect(ready.achievedMinor).toBe(7_000_000);
    expect(ready.readyMinor).toBe(7_000_000);
    expect(ready.achievedTitles).toEqual(["Concept", "IFC"]);
  });

  it("subtracts what is already certified and never goes negative", () => {
    const ready = computeReadyToBill(value, plan, new Set([11]), 4_000_000);
    expect(ready.readyMinor).toBe(3_000_000);
    const overCertified = computeReadyToBill(value, plan, new Set(), 9_999_999);
    expect(overCertified.readyMinor).toBe(0);
  });

  it("parseMilestones preserves stage links and done flags", () => {
    const parsed = parseMilestones(JSON.stringify(plan));
    expect(parsed[0]).toMatchObject({ stageId: 11, done: false });
    expect(parsed[2]).toMatchObject({ stageId: null, done: true });
  });
});

describe("drawing-rate valuation", () => {
  it("derives contract value = Σ count × rate", () => {
    const lines = [
      { title: "HVAC plans", count: 12, rateMinor: 500_000 }, // 12 × 5,000.00
      { title: "Sections", count: 4, rateMinor: 750_000 }, // 4 × 7,500.00
    ];
    expect(drawingsValueMinor(lines)).toBe(9_000_000);
  });

  it("empty lines yield zero", () => {
    expect(drawingsValueMinor([])).toBe(0);
  });

  it("parses valid JSON and rejects malformed entries", () => {
    const parsed = parseDrawings(JSON.stringify([{ title: "ok", count: 2, rateMinor: 100 }, { title: "bad", count: 1.5, rateMinor: 100 }]));
    expect(parsed).toHaveLength(1);
    expect(parseDrawings(null)).toEqual([]);
  });
});
