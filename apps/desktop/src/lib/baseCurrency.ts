import { fromEgpPiasters } from "@mep/core";
import { useSettings } from "./settings";
import { useCurrencyRates } from "../repositories/currencies";
import { useFormat } from "./format";

/**
 * Consolidated figures are computed internally in EGP piasters (the pivot);
 * this hook converts and formats them in the user's chosen main currency
 * (EGP / SAR / USD) at that currency's stored rate.
 */
export function useBaseMoney() {
  const { data: settings } = useSettings();
  const { data: rates = [] } = useCurrencyRates();
  const fmt = useFormat();

  const code = settings?.baseCurrency ?? "EGP";
  const rateMicro = rates.find((r) => r.code === code)?.fxRateMicro ?? 1_000_000;

  const convert = (egpMinor: number) => fromEgpPiasters(egpMinor, code, rateMicro);
  return {
    code,
    convert,
    /** Consolidated display: base currency, no decimals when whole. */
    format: (egpMinor: number) => fmt.money(convert(egpMinor), code, { compactFraction: true }),
  };
}
