import { fromEgpPiasters, toEgpPiasters } from "@mep/core";
import { useSettings } from "./settings";
import { useCurrencyRates } from "../repositories/currencies";
import { useFormat } from "./format";

/**
 * Consolidated figures are computed internally in EGP piasters (the pivot);
 * this hook converts and formats them in the user's chosen main currency
 * (EGP / SAR / USD) at that currency's stored rate.
 *
 * When the source amount is already in the base currency, `convertFrom` /
 * `formatFrom` return it at FACE VALUE — a 10,000 SAR contract always reads
 * 10,000 when the display currency is SAR, no matter how the stored project
 * rate and today's rate have drifted apart. Only foreign amounts go through
 * the EGP pivot.
 */
export function useBaseMoney() {
  const { data: settings } = useSettings();
  const { data: rates = [] } = useCurrencyRates();
  const fmt = useFormat();

  const code = settings?.baseCurrency ?? "EGP";
  const rateMicro = rates.find((r) => r.code === code)?.fxRateMicro ?? 1_000_000;

  const convert = (egpMinor: number) => fromEgpPiasters(egpMinor, code, rateMicro);
  const convertFrom = (amountMinor: number, currency: string, fxRateMicro: number) =>
    currency === code ? amountMinor : convert(toEgpPiasters(amountMinor, currency, fxRateMicro));
  return {
    code,
    convert,
    /** Source-aware conversion: identity for same-currency amounts. */
    convertFrom,
    /** Consolidated display: base currency, no decimals when whole. */
    format: (egpMinor: number) => fmt.money(convert(egpMinor), code, { compactFraction: true }),
    formatFrom: (amountMinor: number, currency: string, fxRateMicro: number) =>
      fmt.money(convertFrom(amountMinor, currency, fxRateMicro), code, { compactFraction: true }),
  };
}
