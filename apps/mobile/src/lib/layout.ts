import { directionFor } from "@mep/core/i18n";

/**
 * Layout direction and Arabic typography for the phone app (plan step F2).
 *
 * Kept free of react-native imports so the rules can be tested without a
 * device. The direction is applied to the whole app as an explicit `direction`
 * style, not through I18nManager: I18nManager only changes after the app is
 * fully restarted, while the in-app language switch must take effect at once.
 */

export type Direction = "rtl" | "ltr";

/** The direction a language is laid out in (one rule, shared with the desktop). */
export function layoutDirection(language: string): Direction {
  return directionFor(language);
}

/** Tajawal files shipped through @expo-google-fonts/tajawal, by weight. */
export const TAJAWAL = {
  regular: "Tajawal_400Regular",
  medium: "Tajawal_500Medium",
  bold: "Tajawal_700Bold",
} as const;

/**
 * Android ignores fontWeight once a custom fontFamily is set (it would fake a
 * bold on top of the file), so each weight is its own family. Weights the
 * screens use today: 400 (default), 500, 600, 700.
 */
export function arabicFontFamily(fontWeight: string | number | undefined): string {
  const weight = fontWeight === "bold" ? 700 : fontWeight === "normal" || fontWeight === undefined ? 400 : Number(fontWeight);
  if (!Number.isFinite(weight) || weight < 500) return TAJAWAL.regular;
  if (weight < 600) return TAJAWAL.medium;
  return TAJAWAL.bold;
}

/** Arabic text uses Tajawal; English keeps the phone's own font. */
export function fontFamilyFor(language: string, fontWeight: string | number | undefined): string | undefined {
  return language === "ar" ? arabicFontFamily(fontWeight) : undefined;
}

/** The "back" chevron points toward the start edge: left in LTR, right in RTL. */
export function backGlyph(direction: Direction): string {
  return direction === "rtl" ? "›" : "‹";
}
