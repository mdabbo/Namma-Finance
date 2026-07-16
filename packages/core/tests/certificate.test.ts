import { describe, expect, it } from "vitest";
import { computeCertificate, type CertificateCalcInput } from "../src/calc/certificate";

/** Contract: 1,000,000 EGP value, 10% advance, VAT 14%, retention 5%, withholding 3%. */
const baseInput = (over: Partial<CertificateCalcInput> = {}): CertificateCalcInput => ({
  grossMinor: 10_000_000, // 100,000.00 EGP certificate
  discountMinor: 0,
  vatBp: 1400,
  retentionBp: 500,
  withholdingBp: 300,
  advance: {
    method: "PROPORTIONAL",
    contractValueMinor: 100_000_000, // 1,000,000.00 EGP
    advanceMinor: 10_000_000, // 100,000.00 EGP advance (10%)
    recoveredBeforeMinor: 0,
  },
  ...over,
});

describe("certificate breakdown — confirmed business rules", () => {
  it("computes the standard breakdown (VAT on gross, deductions on pre-VAT base)", () => {
    const b = computeCertificate(baseInput());
    expect(b.baseMinor).toBe(10_000_000);
    expect(b.vatMinor).toBe(1_400_000); // 14% of base
    expect(b.retentionMinor).toBe(500_000); // 5% of base
    expect(b.advanceRecoveryMinor).toBe(1_000_000); // 10% proportional
    expect(b.withholdingMinor).toBe(300_000); // 3% of base
    // net = 10,000,000 + 1,400,000 − 500,000 − 1,000,000 − 300,000
    expect(b.netPayableMinor).toBe(9_600_000);
  });

  it("net payable identity always holds", () => {
    const b = computeCertificate(baseInput({ grossMinor: 7_777_777, discountMinor: 123_456 }));
    expect(b.netPayableMinor).toBe(
      b.baseMinor + b.vatMinor - b.retentionMinor - b.advanceRecoveryMinor - b.withholdingMinor,
    );
  });

  it("applies the discount before everything (VAT, retention, advance on discounted base)", () => {
    const b = computeCertificate(baseInput({ grossMinor: 10_000_000, discountMinor: 1_000_000 }));
    expect(b.baseMinor).toBe(9_000_000);
    expect(b.vatMinor).toBe(1_260_000); // 14% of 9,000,000 — not of 10,000,000
    expect(b.retentionMinor).toBe(450_000); // 5% of discounted base
    expect(b.advanceRecoveryMinor).toBe(900_000); // proportional to discounted base
    expect(b.withholdingMinor).toBe(270_000);
  });

  it("rejects a discount larger than gross", () => {
    expect(() => computeCertificate(baseInput({ grossMinor: 100, discountMinor: 101 }))).toThrow(RangeError);
  });

  it("rejects negative amounts", () => {
    expect(() => computeCertificate(baseInput({ grossMinor: -1 }))).toThrow(RangeError);
    expect(() => computeCertificate(baseInput({ discountMinor: -1 }))).toThrow(RangeError);
  });

  it("handles zero rates (no VAT / no retention contract)", () => {
    const b = computeCertificate(baseInput({ vatBp: 0, retentionBp: 0, withholdingBp: 0 }));
    expect(b.vatMinor).toBe(0);
    expect(b.retentionMinor).toBe(0);
    expect(b.withholdingMinor).toBe(0);
    expect(b.netPayableMinor).toBe(10_000_000 - 1_000_000); // only advance recovery
  });
});

describe("advance recovery — proportional method", () => {
  it("caps recovery at the remaining advance", () => {
    const b = computeCertificate(
      baseInput({
        advance: {
          method: "PROPORTIONAL",
          contractValueMinor: 100_000_000,
          advanceMinor: 10_000_000,
          recoveredBeforeMinor: 9_500_000, // only 500,000 left
        },
      }),
    );
    expect(b.advanceRecoveryMinor).toBe(500_000); // capped, not 1,000,000
  });

  it("recovers nothing once the advance is fully recovered", () => {
    const b = computeCertificate(
      baseInput({
        advance: {
          method: "PROPORTIONAL",
          contractValueMinor: 100_000_000,
          advanceMinor: 10_000_000,
          recoveredBeforeMinor: 10_000_000,
        },
      }),
    );
    expect(b.advanceRecoveryMinor).toBe(0);
  });

  it("recovers nothing when there is no advance", () => {
    const b = computeCertificate(
      baseInput({
        advance: { method: "PROPORTIONAL", contractValueMinor: 100_000_000, advanceMinor: 0, recoveredBeforeMinor: 0 },
      }),
    );
    expect(b.advanceRecoveryMinor).toBe(0);
  });

  it("guards against a zero contract value", () => {
    const b = computeCertificate(
      baseInput({
        advance: { method: "PROPORTIONAL", contractValueMinor: 0, advanceMinor: 10_000_000, recoveredBeforeMinor: 0 },
      }),
    );
    expect(b.advanceRecoveryMinor).toBe(0);
  });

  it("rounds proportional recovery half-up on odd amounts", () => {
    // base 33,333 × 10% advance ratio = 3,333.3 → 3,333
    const b = computeCertificate(
      baseInput({
        grossMinor: 33_333,
        advance: {
          method: "PROPORTIONAL",
          contractValueMinor: 100_000_000,
          advanceMinor: 10_000_000,
          recoveredBeforeMinor: 0,
        },
      }),
    );
    expect(b.advanceRecoveryMinor).toBe(3_333);
  });
});

describe("advance recovery — manual method", () => {
  it("uses the entered amount, capped at remaining", () => {
    const b = computeCertificate(
      baseInput({
        advance: {
          method: "MANUAL",
          contractValueMinor: 100_000_000,
          advanceMinor: 10_000_000,
          recoveredBeforeMinor: 9_800_000,
          manualRecoveryMinor: 1_000_000,
        },
      }),
    );
    expect(b.advanceRecoveryMinor).toBe(200_000); // capped at remaining
  });

  it("treats a missing manual amount as zero", () => {
    const b = computeCertificate(
      baseInput({
        advance: {
          method: "MANUAL",
          contractValueMinor: 100_000_000,
          advanceMinor: 10_000_000,
          recoveredBeforeMinor: 0,
          manualRecoveryMinor: null,
        },
      }),
    );
    expect(b.advanceRecoveryMinor).toBe(0);
  });

  it("rejects negative manual recovery", () => {
    expect(() =>
      computeCertificate(
        baseInput({
          advance: {
            method: "MANUAL",
            contractValueMinor: 100_000_000,
            advanceMinor: 10_000_000,
            recoveredBeforeMinor: 0,
            manualRecoveryMinor: -1,
          },
        }),
      ),
    ).toThrow(RangeError);
  });
});
