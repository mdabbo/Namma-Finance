import { minorPerMajor } from "./currency";

/**
 * Integer money arithmetic.
 *
 * Every amount is an integer number of minor units (piasters, cents, fils).
 * Every rate is an integer number of basis points (1% = 100 bp, 14% = 1400 bp).
 * FX rates are integers in micro-units: EGP per 1 major unit of the foreign
 * currency × 1,000,000 (48.25 EGP/USD → 48_250_000).
 *
 * Multiplication/division goes through BigInt so intermediate products can
 * never lose precision; results are rounded half-up (half away from zero)
 * and asserted to be safe integers.
 */

export const BP_SCALE = 10_000;
export const FX_MICRO_SCALE = 1_000_000;

export function assertMinor(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer of minor units, got ${value}`);
  }
  return value;
}

export function addMinor(...values: number[]): number {
  let sum = 0;
  for (const v of values) sum += assertMinor(v);
  return assertMinor(sum, "sum");
}

export function subMinor(a: number, b: number): number {
  return assertMinor(assertMinor(a) - assertMinor(b), "difference");
}

/**
 * round(amount * numerator / denominator) with half-up (away from zero)
 * rounding, computed exactly via BigInt.
 */
export function mulDivRound(amount: number, numerator: number, denominator: number): number {
  assertMinor(amount, "amount");
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RangeError("numerator and denominator must be safe integers");
  }
  if (denominator === 0) throw new RangeError("division by zero");

  let n = BigInt(amount) * BigInt(numerator);
  let d = BigInt(denominator);
  if (d < 0n) {
    d = -d;
    n = -n;
  }
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const rounded = (abs * 2n + d) / (d * 2n);
  const result = Number(negative ? -rounded : rounded);
  return assertMinor(result, "mulDivRound result");
}

/** Apply a basis-point rate to an amount: applyBp(10_000_000, 1400) = 1_400_000. */
export function applyBp(amountMinor: number, rateBp: number): number {
  return mulDivRound(amountMinor, rateBp, BP_SCALE);
}

/** Ratio of two amounts expressed in basis points. Zero denominator → 0. */
export function ratioBp(numerator: number, denominator: number): number {
  assertMinor(numerator, "numerator");
  assertMinor(denominator, "denominator");
  if (denominator === 0) return 0;
  return mulDivRound(numerator, BP_SCALE, denominator);
}

/**
 * Split `totalMinor` across `weights` using the largest-remainder method.
 * The parts are guaranteed to sum exactly to the total. All-zero weights
 * split as evenly as possible.
 */
export function allocate(totalMinor: number, weights: number[]): number[] {
  assertMinor(totalMinor, "total");
  if (weights.length === 0) return [];
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) throw new RangeError(`weights must be non-negative safe integers, got ${w}`);
  }
  let weightSum = weights.reduce((a, b) => a + b, 0);
  let effective = weights;
  if (weightSum === 0) {
    effective = weights.map(() => 1);
    weightSum = weights.length;
  }
  const total = BigInt(totalMinor);
  const sum = BigInt(weightSum);
  const negative = total < 0n;
  const absTotal = negative ? -total : total;

  const shares: number[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;
  effective.forEach((w, index) => {
    const exact = absTotal * BigInt(w);
    const share = exact / sum;
    shares.push(Number(share));
    allocated += share;
    remainders.push({ index, remainder: exact % sum });
  });
  let leftover = Number(absTotal - allocated);
  remainders.sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));
  for (let i = 0; leftover > 0; i = (i + 1) % remainders.length, leftover--) {
    const entry = remainders[i]!;
    shares[entry.index] = shares[entry.index]! + 1;
  }
  return negative ? shares.map((s) => -s) : shares;
}

/**
 * Convert an amount in a foreign currency's minor units to EGP piasters.
 * `fxRateMicro` = EGP per 1 major unit of `currencyCode`, × 1e6.
 */
export function toEgpPiasters(amountMinor: number, currencyCode: string, fxRateMicro: number): number {
  assertMinor(amountMinor, "amount");
  if (!Number.isSafeInteger(fxRateMicro) || fxRateMicro <= 0) {
    throw new RangeError(`fxRateMicro must be a positive safe integer, got ${fxRateMicro}`);
  }
  if (currencyCode === "EGP") return amountMinor;
  // piasters = amountMinor / 10^exp (major units) * rate (EGP) * 100
  return mulDivRound(amountMinor, fxRateMicro * 100, FX_MICRO_SCALE * minorPerMajor(currencyCode));
}

/**
 * Inverse of `toEgpPiasters`: convert EGP piasters into another currency's
 * minor units at that currency's stored rate. Used to display consolidated
 * figures in the user's chosen main currency (EGP / SAR / USD).
 */
export function fromEgpPiasters(egpMinor: number, currencyCode: string, fxRateMicro: number): number {
  assertMinor(egpMinor, "amount");
  if (!Number.isSafeInteger(fxRateMicro) || fxRateMicro <= 0) {
    throw new RangeError(`fxRateMicro must be a positive safe integer, got ${fxRateMicro}`);
  }
  if (currencyCode === "EGP") return egpMinor;
  // minor = egpMinor / 100 (EGP) / rate * 10^exp
  return mulDivRound(egpMinor, minorPerMajor(currencyCode) * FX_MICRO_SCALE, fxRateMicro * 100);
}
