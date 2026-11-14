import { useMemo } from "react";
import { reportingValuation, type CurrencyValuation } from "@mep/core";
import { useSettings } from "./settings";
import { useCurrencyRates } from "../repositories/currencies";
import { useFormat } from "./format";

/**
 * The valuation consolidated figures are built with: the user's reporting
 * currency (EGP / SAR / USD) at that currency's stored rate.
 *
 * `settled` is false until the settings and rates have loaded. A settled
 * result with no `valuation` means the reporting currency has no rate at all;
 * the caller must fail rather than fall back to a guessed one, which would
 * misvalue every foreign amount without saying so.
 */
export function useReportingValuation(): {
  currency: string;
  fxRateMicro: number | null;
  valuation: CurrencyValuation | null;
  settled: boolean;
} {
  const settings = useSettings();
  const rates = useCurrencyRates();

  const currency = settings.data?.baseCurrency ?? "EGP";
  // EGP is the pivot: its rate is 1 by definition and needs no lookup.
  const fxRateMicro = currency === "EGP"
    ? 1_000_000
    : rates.data?.find((rate) => rate.code === currency)?.fxRateMicro ?? null;
  const settled = settings.data !== undefined && (currency === "EGP" || rates.data !== undefined);

  const valuation = useMemo(
    () => (settled && fxRateMicro !== null ? reportingValuation(currency, fxRateMicro) : null),
    [settled, currency, fxRateMicro],
  );
  return { currency, fxRateMicro, valuation, settled };
}

/**
 * Formatting for consolidated figures.
 *
 * Consolidated amounts arrive ALREADY valued in the reporting currency — the
 * workspace is built with `useReportingValuation` (see
 * repositories/financials.ts). This hook therefore only formats.
 *
 * It used to convert as well: EGP piasters in, reporting currency out. That
 * conversion sat after the totals had been summed, so an amount that was in
 * the reporting currency to begin with went out through the rate stored on its
 * project and came back through today's — a SAR 325,000 contract read
 * SAR 317,031.19 on a SAR dashboard. There is deliberately no `convert` here
 * any more, so a view cannot apply a second conversion by habit.
 */
export function useBaseMoney() {
  const { data: settings } = useSettings();
  const fmt = useFormat();
  const code = settings?.baseCurrency ?? "EGP";
  return {
    code,
    /** Format an amount already valued in the reporting currency. */
    format: (valuedMinor: number) => fmt.money(valuedMinor, code, { compactFraction: true }),
  };
}
