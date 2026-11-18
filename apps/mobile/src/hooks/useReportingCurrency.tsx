import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CurrencyValuation } from "@mep/core";
import { isReportingCurrency, valuationFor, type ReportingCurrency } from "../lib/reporting";

/**
 * The reporting currency chosen on this phone, and that currency's rate in
 * EGP. Both live on the device (AsyncStorage, `namaa.*` keys like the rest of
 * the app's settings); a rate is kept per currency so switching back and forth
 * does not lose one.
 */

const CURRENCY_KEY = "namaa.reportingCurrency";
const rateKey = (currency: string) => `namaa.reportingRate.${currency}`;

interface ReportingCurrencyState {
  currency: ReportingCurrency;
  /** EGP per major unit × 1,000,000; null when none has been set yet. */
  fxRateMicro: number | null;
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
    const fxRateMicro = currency === "EGP" ? 1_000_000 : rates[currency] ?? null;
    return { currency, fxRateMicro, valuation: valuationFor(currency, fxRateMicro), loaded, setCurrency, setRate };
  }, [currency, rates, loaded, setCurrency, setRate]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useReportingCurrency(): ReportingCurrencyState {
  const value = useContext(Context);
  if (!value) throw new Error("ReportingCurrencyProvider missing");
  return value;
}
