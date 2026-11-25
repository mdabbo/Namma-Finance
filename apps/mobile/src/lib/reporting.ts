import { EGP_VALUATION, reportingValuation, type CurrencyValuation } from "@mep/core";

/**
 * The currency the phone's consolidated totals are shown in (plan step F7).
 *
 * The reporting currency is chosen on the phone. Its rate in EGP comes from
 * the desktop when it has published one (lib/fxRates.ts), and otherwise from a
 * rate typed on the phone. The valuation rule itself is the shared
 * one from @mep/core — an amount already in the reporting currency is taken at
 * face value, anything else goes through the EGP pivot at its own stored rate.
 *
 * Kept free of react-native so it can be tested without a device.
 */

export const REPORTING_CURRENCIES = ["EGP", "SAR", "USD"] as const;
export type ReportingCurrency = (typeof REPORTING_CURRENCIES)[number];

export function isReportingCurrency(value: unknown): value is ReportingCurrency {
  return typeof value === "string" && (REPORTING_CURRENCIES as readonly string[]).includes(value);
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/**
 * A rate typed by a person ("12.85", "١٢٫٨٥", "12,85") as integer micro-units
 * (EGP per major unit × 1,000,000), or null when it is not a usable rate.
 * Parsed as text, never through floating point, so 12.85 is exactly 12850000.
 */
export function parseRateMicro(text: string): number | null {
  const normalized = text
    .trim()
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/[٫,]/g, ".");
  const match = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match) return null;
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0") || "0");
  return micro > 0 ? micro : null;
}

/** Micro-units back to the plain decimal a person would type. */
export function formatRateMicro(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export interface ProjectRate {
  code: string;
  currency: string;
  fxRateMicro: number;
  createdAt: string;
}

/**
 * A starting rate for a currency: the one stored on the most recently created
 * project in that currency. Shown to the person with the project it came
 * from, and only ever used once they keep it — never applied silently.
 */
export function suggestRate(currency: string, projects: ProjectRate[]): ProjectRate | null {
  const matching = projects.filter((p) => p.currency === currency && p.fxRateMicro > 0);
  if (matching.length === 0) return null;
  return [...matching].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.code.localeCompare(b.code))[0]!;
}

/**
 * The valuation to build the workspace with. A foreign currency without a rate
 * has no valuation at all: the caller shows totals in EGP and asks for a rate,
 * rather than guessing one.
 */
export function valuationFor(currency: ReportingCurrency, fxRateMicro: number | null): CurrencyValuation | null {
  if (currency === "EGP") return EGP_VALUATION;
  if (fxRateMicro == null || fxRateMicro <= 0) return null;
  return reportingValuation(currency, fxRateMicro);
}
