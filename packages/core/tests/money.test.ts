import { describe, expect, it } from "vitest";
import {
  addMinor,
  allocate,
  applyBp,
  assertMinor,
  formatMinor,
  mulDivRound,
  ratioBp,
  subMinor,
  toEgpPiasters,
} from "../src/money";

describe("integer money invariants", () => {
  it("rejects non-integer amounts", () => {
    expect(() => assertMinor(10.5)).toThrow(RangeError);
    expect(() => assertMinor(Number.NaN)).toThrow(RangeError);
    expect(() => assertMinor(2 ** 53)).toThrow(RangeError);
    expect(assertMinor(0)).toBe(0);
    expect(assertMinor(-500)).toBe(-500);
  });

  it("adds and subtracts exactly", () => {
    expect(addMinor(1, 2, 3)).toBe(6);
    expect(subMinor(1000, 1)).toBe(999);
    // the classic float trap: 0.1 + 0.2 — impossible here because inputs are integers
    expect(addMinor(10, 20)).toBe(30);
  });
});

describe("mulDivRound (exact bigint math, half-up rounding)", () => {
  it("computes exact products beyond 2^53 without precision loss", () => {
    // 90_071_992_547_409 * 1400 overflows double precision if done naively
    expect(mulDivRound(90_071_992_547_409, 1400, 10_000)).toBe(12_610_078_956_637);
  });

  it("rounds half away from zero", () => {
    expect(mulDivRound(5, 1, 2)).toBe(3); // 2.5 → 3
    expect(mulDivRound(-5, 1, 2)).toBe(-3); // −2.5 → −3
    expect(mulDivRound(3, 1, 2)).toBe(2); // 1.5 → 2
    expect(mulDivRound(1, 1, 3)).toBe(0); // 0.333 → 0
    expect(mulDivRound(2, 1, 3)).toBe(1); // 0.667 → 1
  });

  it("throws on division by zero", () => {
    expect(() => mulDivRound(100, 1, 0)).toThrow(RangeError);
  });
});

describe("basis-point rates", () => {
  it("applies VAT 14% exactly", () => {
    expect(applyBp(10_000_000, 1400)).toBe(1_400_000); // 100,000.00 EGP → 14,000.00
  });

  it("rounds fractional piasters half-up", () => {
    expect(applyBp(33_333, 1400)).toBe(4_667); // 4,666.62 → 4,667
    expect(applyBp(107, 500)).toBe(5); // 5.35 → 5
    expect(applyBp(110, 500)).toBe(6); // 5.5 → 6
  });

  it("ratioBp returns 0 for zero denominator (empty contract)", () => {
    expect(ratioBp(500, 0)).toBe(0);
    expect(ratioBp(0, 0)).toBe(0);
  });

  it("ratioBp computes collection percentages", () => {
    expect(ratioBp(50, 200)).toBe(2500); // 25%
    expect(ratioBp(1, 3)).toBe(3333); // 33.33%
  });
});

describe("allocate (largest remainder)", () => {
  it("always sums exactly to the total", () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("respects weights", () => {
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
    expect(allocate(1001, [1, 1])).toEqual([501, 500]);
  });

  it("handles zero weights by splitting evenly", () => {
    expect(allocate(9, [0, 0, 0])).toEqual([3, 3, 3]);
  });

  it("handles negative totals symmetrically", () => {
    const parts = allocate(-100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-100);
  });

  it("handles empty input", () => {
    expect(allocate(100, [])).toEqual([]);
  });
});

describe("FX conversion to EGP piasters", () => {
  it("EGP passes through unchanged", () => {
    expect(toEgpPiasters(123_456, "EGP", 1_000_000)).toBe(123_456);
  });

  it("converts USD cents at the stored micro rate", () => {
    // 100 USD at 48.25 EGP/USD = 4,825.00 EGP
    expect(toEgpPiasters(10_000, "USD", 48_250_000)).toBe(482_500);
  });

  it("handles 3-exponent currencies (KWD fils)", () => {
    // 1.000 KWD at 157.5 EGP/KWD = 157.50 EGP = 15,750 piasters
    expect(toEgpPiasters(1_000, "KWD", 157_500_000)).toBe(15_750);
  });

  it("rounds sub-piaster results half-up", () => {
    // 1 cent at 48.25 EGP/USD = 0.4825 EGP = 48.25 piasters → 48
    expect(toEgpPiasters(1, "USD", 48_250_000)).toBe(48);
    // 3 cents = 144.75 piasters → 145
    expect(toEgpPiasters(3, "USD", 48_250_000)).toBe(145);
    // 2 cents = 96.5 piasters → 97 (half-up)
    expect(toEgpPiasters(2, "USD", 48_250_000)).toBe(97);
  });

  it("rejects non-positive rates", () => {
    expect(() => toEgpPiasters(100, "USD", 0)).toThrow(RangeError);
  });
});

describe("formatting", () => {
  it("formats EGP for both locales without corrupting the value", () => {
    const en = formatMinor(123_456_789, "EGP", "en");
    const arabic = formatMinor(123_456_789, "EGP", "ar");
    expect(en).toContain("1,234,567.89");
    expect(arabic).toContain("1,234,567.89"); // Latin digits by default in ar
  });

  it("formats 3-exponent currencies with 3 decimals", () => {
    expect(formatMinor(1_500, "KWD", "en")).toContain("1.500");
  });
});
