import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resources, DEFAULT_LOCALE } from "@mep/core/i18n";

/** Same dictionaries as the desktop app — one wording everywhere. */
export function initI18n(language: "ar" | "en" = DEFAULT_LOCALE): void {
  void i18n.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
}

export default i18n;
