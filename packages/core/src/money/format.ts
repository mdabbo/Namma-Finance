import { currencyInfo } from "./currency";
import { BP_SCALE } from "./money";

export type AppLocale = "ar" | "en";

/**
 * Intl locale tags. Arabic uses Latin (ASCII) digits by default so financial
 * tables stay aligned and copy-pasteable; callers can opt into Eastern
 * Arabic digits via `easternDigits`.
 */
function intlLocale(locale: AppLocale, easternDigits?: boolean): string {
  if (locale === "ar") return easternDigits ? "ar-EG" : "ar-EG-u-nu-latn";
  return "en-EG";
}

export interface FormatMoneyOptions {
  /** Hide the fractional part when it is zero (default false). */
  compactFraction?: boolean;
  /** Use Eastern Arabic digits for Arabic locale (default false). */
  easternDigits?: boolean;
  /** Show the currency code/symbol (default true). */
  showCurrency?: boolean;
}

/** Format an integer minor-unit amount for display. */
export function formatMinor(
  amountMinor: number,
  currencyCode: string,
  locale: AppLocale,
  options: FormatMoneyOptions = {},
): string {
  const { exponent } = currencyInfo(currencyCode);
  const major = amountMinor / 10 ** exponent;
  const hideFraction = options.compactFraction === true && Number.isInteger(major);
  const digits = hideFraction ? 0 : exponent;
  if (options.showCurrency === false) {
    return new Intl.NumberFormat(intlLocale(locale, options.easternDigits), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  }
  return new Intl.NumberFormat(intlLocale(locale, options.easternDigits), {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(major);
}

/** Format basis points as a percentage string, e.g. 1400 → "14%". */
export function formatBp(rateBp: number, locale: AppLocale, easternDigits?: boolean): string {
  return new Intl.NumberFormat(intlLocale(locale, easternDigits), {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(rateBp / BP_SCALE);
}

/** Format an ISO date (YYYY-MM-DD) for display. */
export function formatIsoDate(isoDate: string, locale: AppLocale, easternDigits?: boolean): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return new Intl.DateTimeFormat(intlLocale(locale, easternDigits), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
