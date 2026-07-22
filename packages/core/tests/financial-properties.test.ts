import { describe, expect, it } from "vitest";
import type { Contract, PaymentCertificate, Project } from "../src/domain/types";
import { computeContractState } from "../src/calc/contract";
import { allocate, applyBp, mulDivRound, ratioBp, toEgpPiasters } from "../src/money";

/** Deterministic generator: reproducible in CI while exploring thousands of boundaries. */
function generator(seed: number) {
  let state = seed >>> 0;
  return (max: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % max;
  };
}

describe("financial property and fuzz invariants", () => {
  it("largest-remainder allocations conserve every minor unit", () => {
    const next = generator(0x4e414d41);
    for (let run = 0; run < 2_000; run += 1) {
      const total = next(20_000_001) - 10_000_000;
      const count = next(30) + 1;
      const weights = Array.from({ length: count }, () => next(1_000));
      const parts = allocate(total, weights);
      expect(parts).toHaveLength(count);
      expect(parts.reduce((sum, value) => sum + value, 0)).toBe(total);
      expect(parts.every(Number.isSafeInteger)).toBe(true);
    }
  });

  it("BigInt-backed half-up rounding is sign symmetric", () => {
    const next = generator(0x50494153);
    for (let run = 0; run < 5_000; run += 1) {
      const amount = next(1_000_000_000);
      const numerator = next(20_001);
      const denominator = next(20_000) + 1;
      expect(mulDivRound(-amount, numerator, denominator) === -mulDivRound(amount, numerator, denominator)).toBe(true);
    }
  });

  it("basis-point application and ratios stay integral at boundaries", () => {
    const next = generator(0x454750);
    for (let run = 0; run < 2_000; run += 1) {
      const amount = next(100_000_000);
      const bp = next(10_001);
      const applied = applyBp(amount, bp);
      expect(Number.isSafeInteger(applied)).toBe(true);
      expect(applied).toBeGreaterThanOrEqual(0);
      expect(applied).toBeLessThanOrEqual(amount);
      expect(ratioBp(applied, amount || 1)).toBeGreaterThanOrEqual(0);
    }
  });

  it("reconciles advance recovery and certified totals across many-certificate contracts", () => {
    const contract: Contract = {
      id: 1, projectId: 1, number: "C-FUZZ", title: null, valueMinor: 750_000_000,
      vatBp: 1_400, retentionBp: 500, withholdingBp: 100, advanceMinor: 75_000_000,
      advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null,
      performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
      valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null,
      signedDate: "2026-01-01", notes: null, createdAt: "2026-01-01",
    };
    const next = generator(0x43455254);
    const certificates: PaymentCertificate[] = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1, contractId: 1, seq: index + 1, number: `PC-${index + 1}`,
      date: "2026-02-01", submissionDate: "2026-02-01", dueDateOverride: null,
      description: null, grossMinor: next(2_000_000) + 10_000, discountMinor: next(10_000),
      manualAdvanceRecoveryMinor: null, status: "APPROVED", deletedAt: null,
      createdAt: "2026-02-01",
    }));
    const state = computeContractState({ contract, certificates, payments: [], allocations: [], todayIso: "2026-07-22" });
    const expectedBase = certificates.reduce((sum, certificate) => sum + certificate.grossMinor - certificate.discountMinor, 0);
    expect(state.certificates).toHaveLength(500);
    expect(state.certifiedBaseMinor).toBe(expectedBase);
    expect(state.advanceRecoveredMinor).toBeLessThanOrEqual(contract.advanceMinor);
    expect(state.advanceRecoveredMinor + state.advanceRemainingMinor).toBe(contract.advanceMinor);
    expect(Number.isSafeInteger(state.totalDueMinor)).toBe(true);
  });

  it("keeps large multi-currency EGP rollups integral and independent of input order", () => {
    const next = generator(0x4658524f);
    const currencies = ["EGP", "USD", "SAR"] as const;
    const rates = { EGP: 1_000_000, USD: 48_250_000, SAR: 12_860_000 } as const;
    const projects: Array<Pick<Project, "currency" | "fxRateMicro"> & { amountMinor: number }> =
      Array.from({ length: 2_000 }, (_, index) => {
        const currency = currencies[index % currencies.length]!;
        return { currency, fxRateMicro: rates[currency], amountMinor: next(10_000_000) };
      });
    const rollup = (rows: typeof projects) => rows.reduce(
      (sum, row) => sum + toEgpPiasters(row.amountMinor, row.currency, row.fxRateMicro), 0,
    );
    const forward = rollup(projects);
    expect(forward).toBe(rollup([...projects].reverse()));
    expect(Number.isSafeInteger(forward)).toBe(true);
    expect(forward).toBeGreaterThanOrEqual(0);
  });
});
