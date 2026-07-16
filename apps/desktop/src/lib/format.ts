import { useTranslation } from "react-i18next";
import { formatBp, formatIsoDate, formatMinor, type AppLocale, type FormatMoneyOptions } from "@mep/core";

/** Locale-bound formatting helpers for components. */
export function useFormat() {
  const { i18n } = useTranslation();
  const locale = (i18n.language === "ar" ? "ar" : "en") as AppLocale;
  return {
    locale,
    money: (amountMinor: number, currency = "EGP", options?: FormatMoneyOptions) =>
      formatMinor(amountMinor, currency, locale, options),
    /** Consolidated EGP figures on dashboards: no decimals for readability. */
    moneyCompact: (amountMinor: number, currency = "EGP") =>
      formatMinor(amountMinor, currency, locale, { compactFraction: true }),
    percent: (bp: number) => formatBp(bp, locale),
    date: (iso: string | null | undefined) => (iso ? formatIsoDate(iso, locale) : "—"),
  };
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Parse a user-entered decimal string into integer minor units. Rejects NaN. */
export function parseToMinor(text: string, exponent = 2): number | null {
  const cleaned = text.replace(/[,\s٫٬ ]/g, "").replace("٫", ".");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) return null;
  const [intPart = "0", fracPart = ""] = cleaned.replace("-", "").split(".");
  const frac = (fracPart + "0".repeat(exponent)).slice(0, exponent);
  const sign = cleaned.startsWith("-") ? -1 : 1;
  const value = sign * (Number(intPart) * 10 ** exponent + Number(frac || "0"));
  return Number.isSafeInteger(value) ? value : null;
}

/** Render integer minor units as a plain decimal string for form inputs. */
export function minorToInput(amountMinor: number | null | undefined, exponent = 2): string {
  if (amountMinor === null || amountMinor === undefined) return "";
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 10 ** exponent);
  const frac = String(abs % 10 ** exponent).padStart(exponent, "0");
  return frac === "0".repeat(exponent) ? `${sign}${major}` : `${sign}${major}.${frac}`;
}

/** Basis points ⇄ human percent text (e.g. 1400 ⇄ "14"). */
export function bpToInput(bp: number): string {
  return String(bp / 100);
}
export function parseToBp(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, "").replace("٫", ".");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 100);
}
