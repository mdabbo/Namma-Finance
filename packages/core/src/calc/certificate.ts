import { applyBp, assertMinor, mulDivRound } from "../money/money";
import type { AdvanceRecoveryMethod } from "../domain/types";

/**
 * Payment-certificate calculation — the confirmed business rules:
 *
 *   base       = gross − discount            (discount applies before everything)
 *   VAT        = base × vatBp                (VAT on the discounted gross)
 *   retention  = base × retentionBp          (withheld per certificate, released at end)
 *   advance    = PROPORTIONAL: base × (contract advance ÷ contract value),
 *                capped at the un-recovered advance remaining
 *                MANUAL: entered per certificate, same cap
 *   withholding= base × withholdingBp
 *   net payable= base + VAT − retention − advance − withholding
 */

export interface CertificateCalcInput {
  grossMinor: number;
  discountMinor: number;
  vatBp: number;
  retentionBp: number;
  withholdingBp: number;
  advance: {
    method: AdvanceRecoveryMethod;
    contractValueMinor: number;
    advanceMinor: number;
    /** Advance already recovered by earlier certificates of the same contract. */
    recoveredBeforeMinor: number;
    /** Only read when method is MANUAL. */
    manualRecoveryMinor?: number | null;
  };
}

export interface CertificateBreakdown {
  grossMinor: number;
  discountMinor: number;
  /** gross − discount: the base for every rate. */
  baseMinor: number;
  vatMinor: number;
  retentionMinor: number;
  advanceRecoveryMinor: number;
  withholdingMinor: number;
  netPayableMinor: number;
}

export function computeCertificate(input: CertificateCalcInput): CertificateBreakdown {
  const gross = assertMinor(input.grossMinor, "gross");
  const discount = assertMinor(input.discountMinor, "discount");
  if (gross < 0) throw new RangeError("gross must be >= 0");
  if (discount < 0) throw new RangeError("discount must be >= 0");
  if (discount > gross) throw new RangeError("discount cannot exceed gross");

  const base = gross - discount;
  const vat = applyBp(base, input.vatBp);
  const retention = applyBp(base, input.retentionBp);
  const withholding = applyBp(base, input.withholdingBp);
  const advanceRecovery = computeAdvanceRecovery(base, input.advance);

  return {
    grossMinor: gross,
    discountMinor: discount,
    baseMinor: base,
    vatMinor: vat,
    retentionMinor: retention,
    advanceRecoveryMinor: advanceRecovery,
    withholdingMinor: withholding,
    netPayableMinor: base + vat - retention - advanceRecovery - withholding,
  };
}

function computeAdvanceRecovery(baseMinor: number, advance: CertificateCalcInput["advance"]): number {
  const { method, contractValueMinor, advanceMinor, recoveredBeforeMinor } = advance;
  assertMinor(advanceMinor, "advance");
  assertMinor(recoveredBeforeMinor, "recoveredBefore");
  const remaining = Math.max(0, advanceMinor - recoveredBeforeMinor);
  if (remaining === 0) return 0;

  if (method === "MANUAL") {
    const manual = advance.manualRecoveryMinor ?? 0;
    assertMinor(manual, "manualRecovery");
    if (manual < 0) throw new RangeError("manual advance recovery must be >= 0");
    return Math.min(manual, remaining);
  }

  if (contractValueMinor <= 0) return 0;
  const proportional = mulDivRound(baseMinor, advanceMinor, contractValueMinor);
  return Math.min(proportional, remaining);
}
