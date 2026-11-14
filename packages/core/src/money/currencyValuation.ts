import { assertMinor, fromEgpPiasters, toEgpPiasters } from "./money";

/**
 * How a source amount is expressed in the currency a consolidated figure is
 * reported in.
 *
 * Consolidated totals used to be built in EGP piasters and converted to the
 * reporting currency afterwards. For an amount already IN the reporting
 * currency that is a round trip through two different rates — the rate stored
 * on the record going in, today's rate coming out — so a SAR 325,000 contract
 * read SAR 317,031.19 on a SAR dashboard, and moved every time the central
 * bank rate did. That defect was fixed once in the view layer (July 2026) and
 * silently returned when the dashboard maths moved into this package, because
 * the conversion happened after the amounts had lost their currency.
 *
 * So the currency decision is made HERE, per source record, while the record's
 * own currency is still known:
 *
 *  - an amount already in the reporting currency is taken at FACE VALUE;
 *  - any other amount is valued through the EGP pivot: its own stored rate
 *    in, the reporting currency's rate out.
 *
 * Every consolidated figure is then a plain integer sum of valued amounts, so
 * the identities the dashboard promises (parts sum to the total, profit is
 * revenue less cost) hold exactly in the currency the user is looking at —
 * not merely in EGP, where converting each side separately could leave the
 * displayed parts a minor unit away from the displayed total.
 */
export interface CurrencyValuation {
  /** The currency every valued amount is expressed in. */
  readonly currency: string;
  /**
   * Value `amountMinor` (held in `currency`, whose stored rate is
   * `fxRateMicro` EGP per major unit) in this valuation's currency.
   */
  value(amountMinor: number, currency: string, fxRateMicro: number): number;
}

/** The EGP pivot itself: every amount at its own stored rate. */
export const EGP_VALUATION: CurrencyValuation = Object.freeze({
  currency: "EGP",
  value: toEgpPiasters,
});

/**
 * The valuation for reports shown in `currency`, whose current rate is
 * `fxRateMicro` EGP per major unit.
 */
export function reportingValuation(currency: string, fxRateMicro: number): CurrencyValuation {
  if (currency === "EGP") return EGP_VALUATION;
  assertRate(fxRateMicro);
  return Object.freeze({
    currency,
    value(amountMinor: number, source: string, sourceFxRateMicro: number): number {
      assertMinor(amountMinor, "amount");
      // Checked even when it will not be used: a record with a corrupt rate
      // must fail the same way whichever currency the report is shown in,
      // rather than passing quietly only for same-currency reports.
      assertRate(sourceFxRateMicro);
      // Face value: no rate is applied, so none can drift.
      if (source === currency) return amountMinor;
      return fromEgpPiasters(
        toEgpPiasters(amountMinor, source, sourceFxRateMicro),
        currency,
        fxRateMicro,
      );
    },
  });
}

function assertRate(fxRateMicro: number): void {
  if (!Number.isSafeInteger(fxRateMicro) || fxRateMicro <= 0) {
    throw new RangeError(`fxRateMicro must be a positive safe integer, got ${fxRateMicro}`);
  }
}
