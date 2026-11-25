import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import type { CurrencyValuation } from "@mep/core";
import { isReportingCurrency, valuationFor, type ReportingCurrency } from "../lib/reporting";
import { chooseRate, loadDesktopRates, type RateSource } from "../lib/fxRates";
import { useSupabase } from "./useWorkspace";

/**
 * The reporting currency chosen on this phone, and that currency's rate in
 * EGP. The currency lives on the device (AsyncStorage, `namaa.*` keys like the
 * rest of the app's settings). The rate is the desktop's when it has published
 * one (lib/fxRates.ts); otherwise the one typed here, kept per currency so
 * switching back and forth does not lose one.
 */

const CURRENCY_KEY = "namaa.reportingCurrency";
const rateKey = (currency: string) => `namaa.reportingRate.${currency}`;

interface ReportingCurrencyState {
  currency: ReportingCurrency;
  /** EGP per major unit × 1,000,000; null when none has been set yet. */
  fxRateMicro: number | null;
  /** Whose rate it is: the desktop's, or one typed on this phone. */
  rateSource: RateSource | null;
  /** When the desktop last changed the rate (ISO); null for a typed one. */
  rateUpdatedAt: string | null;
  /** Null for a foreign currency that has no rate yet: totals stay in EGP. */
  valuation: CurrencyValuation | null;
  loaded: boolean;
  setCurrency: (currency: ReportingCurrency) => Promise<void>;
  setRate: (currency: ReportingCurrency, fxRateMicro: number) => Promise<void>;
}

const Context = createContext<ReportingCurrencyState | null>(null);

export function ReportingCurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<ReportingCurrency>("EGP");
  const [rates, setRates] = useState<Partial<Record<ReportingCurrency, number>>>({});
  const [loaded, setLoaded] = useState(false);
  const client = useSupabase();
  // A failed or missing table answers with no rates, and the phone falls back
  // to the typed ones; it is retried on the next open or refresh.
  const desktop = useQuery({ queryKey: ["fx-rates"], queryFn: () => loadDesktopRates(client), staleTime: 5 * 60_000 });

  useEffect(() => {
    void (async () => {
      const [stored, sar, usd] = await Promise.all([
        AsyncStorage.getItem(CURRENCY_KEY),
        AsyncStorage.getItem(rateKey("SAR")),
        AsyncStorage.getItem(rateKey("USD")),
      ]);
      if (isReportingCurrency(stored)) setCurrencyState(stored);
      const parsed: Partial<Record<ReportingCurrency, number>> = {};
      for (const [code, value] of [["SAR", sar], ["USD", usd]] as const) {
        const micro = Number(value);
        if (value && Number.isSafeInteger(micro) && micro > 0) parsed[code] = micro;
      }
      setRates(parsed);
      setLoaded(true);
    })();
  }, []);

  const setCurrency = useCallback(async (next: ReportingCurrency) => {
    setCurrencyState(next);
    await AsyncStorage.setItem(CURRENCY_KEY, next);
  }, []);

  const setRate = useCallback(async (code: ReportingCurrency, fxRateMicro: number) => {
    setRates((current) => ({ ...current, [code]: fxRateMicro }));
    await AsyncStorage.setItem(rateKey(code), String(fxRateMicro));
  }, []);

  const value = useMemo<ReportingCurrencyState>(() => {
    const chosen = chooseRate(currency, desktop.data ?? {}, currency === "EGP" ? null : rates[currency] ?? null);
    return {
      currency,
      fxRateMicro: chosen.fxRateMicro,
      rateSource: chosen.source,
      rateUpdatedAt: chosen.updatedAt,
      valuation: valuationFor(currency, chosen.fxRateMicro),
      // Wait for the desktop's answer before the first figures, so they are not
      // computed at a typed rate and then recomputed a moment later.
      loaded: loaded && !desktop.isPending,
      setCurrency,
      setRate,
    };
  }, [currency, rates, desktop.data, desktop.isPending, loaded, setCurrency, setRate]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useReportingCurrency(): ReportingCurrencyState {
  const value = useContext(Context);
  if (!value) throw new Error("ReportingCurrencyProvider missing");
  return value;
}
