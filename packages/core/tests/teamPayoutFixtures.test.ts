import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  allocate,
  computeTeamPayout,
  milestoneAmounts,
  type ContractState,
  type PercentMilestone,
} from "../src";

/**
 * The arithmetic the payout schedule is built on, asserted by both engines.
 *
 * `cancel_assignment_atomic` derives the earned figure it freezes, which means
 * `computeTeamPayout` now exists twice — here and in Rust. Allocation is where
 * a port drifts most easily: flooring, then handing leftover units to the
 * largest remainders with ties broken by index, is easy to get almost right.
 * "Almost" would freeze a figure a piastre off and migration 0004 would make it
 * permanent.
 *
 * Rust side: `team_payout_fixtures_match_typescript` in
 * apps/desktop/src-tauri/src/lib.rs.
 */
interface AllocateFixture {
  name: string;
  total: number;
  weights: number[];
  expected: number[];
}

interface MilestoneFixture {
  name: string;
  valueMinor: number;
  percentsBp: number[];
  expected: number[];
}

interface PayoutFixture {
  name: string;
  agreedMinor: number;
  personPaidMinor: number;
  contracts: Array<{
    id: number;
    number: string;
    valueMinor: number;
    valuationMode: string;
    milestones: PercentMilestone[] | null;
    certificates: Array<{ id: number; seq: number; number: string; status: string; baseMinor: number }>;
  }>;
  expectedStages: Array<{ weightMinor: number; amountMinor: number; status: string }>;
  expectedReleasedMinor: number;
  expectedDueMinor: number;
}

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../fixtures/team-payout.json"), "utf8"),
) as {
  allocate: AllocateFixture[];
  milestoneAmounts: MilestoneFixture[];
  payoutSchedules: PayoutFixture[];
};

function statesFor(fixture: PayoutFixture): ContractState[] {
  return fixture.contracts.map((contract) => ({
    contract: {
      id: contract.id,
      number: contract.number,
      valueMinor: contract.valueMinor,
      valuationMode: contract.valuationMode,
      milestones: contract.milestones === null ? null : JSON.stringify(contract.milestones),
    },
    certificates: contract.certificates.map((certificate) => ({
      certificate: {
        id: certificate.id,
        seq: certificate.seq,
        number: certificate.number,
        description: null,
        status: certificate.status,
      },
      breakdown: { baseMinor: certificate.baseMinor },
    })),
  })) as unknown as ContractState[];
}

describe("shared team payout fixtures", () => {
  it("covers the cases a port gets wrong", () => {
    expect(fixtures.allocate.length).toBeGreaterThanOrEqual(12);
    expect(fixtures.milestoneAmounts.length).toBeGreaterThanOrEqual(5);
    expect(fixtures.payoutSchedules.length).toBeGreaterThanOrEqual(3);
  });

  it.each(fixtures.allocate.map((f) => [f.name, f] as const))(
    "allocate: %s",
    (_name, fixture) => {
      expect(allocate(fixture.total, fixture.weights)).toEqual(fixture.expected);
    },
  );

  it("always splits the whole total, leaving nothing behind", () => {
    for (const fixture of fixtures.allocate) {
      const parts = allocate(fixture.total, fixture.weights);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(fixture.total);
    }
  });

  it.each(fixtures.milestoneAmounts.map((f) => [f.name, f] as const))(
    "milestoneAmounts: %s",
    (_name, fixture) => {
      const milestones: PercentMilestone[] = fixture.percentsBp.map((percentBp, index) => ({
        title: `M${index + 1}`,
        percentBp,
      }));
      expect(milestoneAmounts(fixture.valueMinor, milestones)).toEqual(fixture.expected);
    },
  );

  it.each(fixtures.payoutSchedules.map((f) => [f.name, f] as const))(
    "computeTeamPayout: %s",
    (_name, fixture) => {
      const result = computeTeamPayout(
        fixture.agreedMinor,
        statesFor(fixture),
        fixture.personPaidMinor,
      );
      expect(result.stages.map(({ weightMinor, amountMinor, status }) => ({
        weightMinor,
        amountMinor,
        status,
      }))).toEqual(fixture.expectedStages);
      expect(result.releasedMinor).toBe(fixture.expectedReleasedMinor);
      expect(result.dueMinor).toBe(fixture.expectedDueMinor);
    },
  );
});
