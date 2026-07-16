import { en, type Dictionary } from "./en";
import { ar } from "./ar";

export type { Dictionary };
export { en, ar };

export const DEFAULT_LOCALE = "ar" as const;

/** i18next-compatible resource bundle shared by desktop and mobile. */
export const resources = {
  en: { translation: en },
  ar: { translation: ar },
} as const;

export function directionFor(locale: string): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}
