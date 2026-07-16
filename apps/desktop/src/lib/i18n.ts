import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { resources, DEFAULT_LOCALE, directionFor } from "@mep/core/i18n";

export function initI18n(initialLanguage?: string): void {
  void i18next.use(initReactI18next).init({
    resources,
    lng: initialLanguage ?? DEFAULT_LOCALE,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  applyDirection(initialLanguage ?? DEFAULT_LOCALE);
}

export function applyDirection(language: string): void {
  const dir = directionFor(language);
  document.documentElement.setAttribute("dir", dir);
  document.documentElement.setAttribute("lang", language);
}

export async function switchLanguage(language: string): Promise<void> {
  await i18next.changeLanguage(language);
  applyDirection(language);
}
