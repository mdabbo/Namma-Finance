import type { SupabaseClient } from "@supabase/supabase-js";
import { isReportingCurrency, type ReportingCurrency } from "./reporting";

/**
 * The exchange rates the desktop publishes to the cloud (fx_rates, see
 * docs/supabase-0024-fx-rates.sql), and which rate the phone uses.
 *
 * The desktop is where rates are fetched from the Central Bank of Egypt or
 * typed, so when it has published one for the reporting currency, that rate
 * is the one the phone uses: both apps then report the same figures. A rate
 * typed on the phone is only the fallback for a phone whose desktop has not
 * published yet (the cloud table missing, or the desktop not updated or synced).
 *
 * Reading only: the phone never writes this table.
 */

export interface DesktopRate {
  /** EGP per major unit × 1,000,000, the desktop's own unit. */
  fxRateMicro: number;
  /** When the desktop last changed it (ISO). */
  updatedAt: string;
}

export type DesktopRates = Partial<Record<ReportingCurrency, DesktopRate>>;

export type RateSource = "desktop" | "typed";

export interface ChosenRate {
  fxRateMicro: number | null;
  source: RateSource | null;
  updatedAt: string | null;
}

/** Cloud rows to the rates the phone can use: SAR and USD, sane values only. */
export function parseDesktopRates(rows: unknown): DesktopRates {
  const out: DesktopRates = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows as Record<string, unknown>[]) {
    const code = row?.code;
    if (!isReportingCurrency(code) || code === "EGP") continue;
    const micro = Number(row.fx_rate_micro);
    if (!Number.isSafeInteger(micro) || micro <= 0) continue;
    const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
    const existing = out[code];
    // The newest row wins if a currency somehow appears twice.
    if (existing && existing.updatedAt >= updatedAt) continue;
    out[code] = { fxRateMicro: micro, updatedAt };
  }
  return out;
}

/** The desktop's published rates; empty when the table is missing or unreadable. */
export async function loadDesktopRates(client: SupabaseClient): Promise<DesktopRates> {
  const { data, error } = await client.from("fx_rates").select("code,fx_rate_micro,updated_at");
  if (error) return {};
  return parseDesktopRates(data);
}

/**
 * The rate to use for a currency: the desktop's if it has published one,
 * otherwise the one typed on this phone, otherwise none. EGP is always 1.
 */
export function chooseRate(currency: ReportingCurrency, desktop: DesktopRates, typedMicro: number | null): ChosenRate {
  if (currency === "EGP") return { fxRateMicro: 1_000_000, source: null, updatedAt: null };
  const published = desktop[currency];
  if (published) return { fxRateMicro: published.fxRateMicro, source: "desktop", updatedAt: published.updatedAt };
  if (typedMicro != null && typedMicro > 0) return { fxRateMicro: typedMicro, source: "typed", updatedAt: null };
  return { fxRateMicro: null, source: null, updatedAt: null };
}

/** Whole days since a rate was changed; null when the time cannot be read. */
export function rateAgeDays(updatedAt: string | null, nowMs: number): number | null {
  if (!updatedAt) return null;
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((nowMs - then) / 86_400_000));
}

/** A rate older than this is worth a warning: the Central Bank's rates move. */
export const STALE_RATE_DAYS = 14;
