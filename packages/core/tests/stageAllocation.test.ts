import { describe, expect, it } from "vitest";
import { allocateStageAmounts, parseContractFees, serializeContractFees } from "../src/calc/stageAllocation";

// Contract 0004 stages 40/20/20/20 of 20,461.55; contract 0006 the same shape of 17,538.45.
const stages = [
  ...[4000, 2000, 2000, 2000].map((p) => ({ contractNumber: "A", weightMinor: p * 2_046_155 / 10000 })),
  ...[4000, 2000, 2000, 2000].map((p) => ({ contractNumber: "B", weightMinor: p * 1_753_845 / 10000 })),
].map((s) => ({ ...s, weightMinor: Math.round(s.weightMinor) }));

describe("allocateStageAmounts", () => {
  it("without fees equals the single-fee proportional split (unchanged behaviour)", () => {
    const amounts = allocateStageAmounts(3_800_000, stages);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(3_800_000);
    expect(amounts[0]).toBe(818_462); // the uneven figure users complained about
  });

  it("a fee per contract gives round stage amounts", () => {
    const amounts = allocateStageAmounts(3_800_000, stages, { A: 2_000_000, B: 1_800_000 });
    expect(amounts).toEqual([800_000, 400_000, 400_000, 400_000, 720_000, 360_000, 360_000, 360_000]);
  });

  it("contracts without a fee share the remainder proportionally", () => {
    const amounts = allocateStageAmounts(3_800_000, stages, { A: 2_000_000 });
    expect(amounts.slice(0, 4)).toEqual([800_000, 400_000, 400_000, 400_000]);
    expect(amounts.slice(4).reduce((a, b) => a + b, 0)).toBe(1_800_000);
  });

  it("never allocates more than the agreed fee", () => {
    const amounts = allocateStageAmounts(1_000_000, stages, { A: 800_000, B: 800_000 });
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(1_000_000);
    expect(amounts.slice(4).reduce((a, b) => a + b, 0)).toBe(200_000);
  });

  it("ignores a fee for a contract that is not on the project", () => {
    expect(allocateStageAmounts(3_800_000, stages, { ZZ: 1 })).toEqual(allocateStageAmounts(3_800_000, stages));
  });
});

describe("contract fee JSON", () => {
  it("round-trips and drops junk", () => {
    expect(parseContractFees(serializeContractFees({ A: 5 }))).toEqual({ A: 5 });
    expect(parseContractFees("not json")).toEqual({});
    expect(parseContractFees('{"A":1.5,"B":-1,"C":7}')).toEqual({ C: 7 });
    expect(serializeContractFees({})).toBeNull();
  });
});

import fixtures from "../../../fixtures/team-payout.json";

describe("shared fixtures (also asserted by the Rust engine)", () => {
  it.each(fixtures.stageAllocations.map((f) => [f.name, f] as const))("%s", (_name, f) => {
    const actual = allocateStageAmounts(f.agreedMinor, f.stages, f.fees);
    expect(actual).toEqual(f.expected);
    // Nothing is invented; any shortfall is only a contract that had no stage to take it.
    expect(actual.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(f.agreedMinor);
  });
});
