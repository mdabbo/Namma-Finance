/**
 * Currency registry. `exponent` is the number of minor-unit digits
 * (EGP piasters = 2, KWD fils = 3). All amounts in the system are stored
 * as integers in the currency's minor unit.
 */
export interface CurrencyInfo {
  code: string;
  /** Number of decimal digits of the minor unit (ISO 4217). */
  exponent: number;
  nameEn: string;
  nameAr: string;
}

export const CURRENCIES: Record<string, CurrencyInfo> = {
  EGP: { code: "EGP", exponent: 2, nameEn: "Egyptian Pound", nameAr: "جنيه مصري" },
  USD: { code: "USD", exponent: 2, nameEn: "US Dollar", nameAr: "دولار أمريكي" },
  EUR: { code: "EUR", exponent: 2, nameEn: "Euro", nameAr: "يورو" },
  GBP: { code: "GBP", exponent: 2, nameEn: "Pound Sterling", nameAr: "جنيه إسترليني" },
  SAR: { code: "SAR", exponent: 2, nameEn: "Saudi Riyal", nameAr: "ريال سعودي" },
  AED: { code: "AED", exponent: 2, nameEn: "UAE Dirham", nameAr: "درهم إماراتي" },
  QAR: { code: "QAR", exponent: 2, nameEn: "Qatari Riyal", nameAr: "ريال قطري" },
  KWD: { code: "KWD", exponent: 3, nameEn: "Kuwaiti Dinar", nameAr: "دينار كويتي" },
  BHD: { code: "BHD", exponent: 3, nameEn: "Bahraini Dinar", nameAr: "دينار بحريني" },
  OMR: { code: "OMR", exponent: 3, nameEn: "Omani Rial", nameAr: "ريال عماني" },
  JOD: { code: "JOD", exponent: 3, nameEn: "Jordanian Dinar", nameAr: "دينار أردني" },
} as const;

export const BASE_CURRENCY = "EGP";

export function currencyInfo(code: string): CurrencyInfo {
  const info = CURRENCIES[code];
  if (!info) throw new RangeError(`Unknown currency code: ${code}`);
  return info;
}

/** 10^exponent for a currency — minor units per major unit. */
export function minorPerMajor(code: string): number {
  return 10 ** currencyInfo(code).exponent;
}
