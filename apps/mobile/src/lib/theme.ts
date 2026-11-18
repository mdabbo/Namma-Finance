import { Platform, type ViewStyle } from "react-native";

/**
 * The phone app's design tokens — the same DABWORKS brand the desktop uses:
 * Deep Navy drives actions and headings, DAB Orange is an accent fill only
 * (never small text on white: it measures 3.0:1), neutrals are Ink / Mist /
 * Stone. Keep every colour here so a screen never invents its own.
 */
export const colors = {
  // brand
  brand: "#0b2545", // Deep Navy
  brandSoft: "#13315c",
  brandTint: "#e8eef6",
  accent: "#f36c21", // DAB Orange — fills only
  accentTint: "#fdeee5",

  // surfaces
  bg: "#f3f5f8", // Mist
  card: "#ffffff",
  border: "#e3e7ec",
  divider: "#eef1f4",
  chipBg: "#f2f6fa",

  // text
  text: "#1c2433", // Ink
  subtle: "#5c6673",
  faint: "#8a94a1",
  onBrand: "#ffffff",
  onBrandSubtle: "#b9c6d8",

  // meaning
  green: "#047857",
  greenTint: "#e7f6ef",
  amber: "#b45309",
  amberTint: "#fdf3e1",
  red: "#c0262d",
  redTint: "#fdecec",
  blue: "#1d4f91",
  blueTint: "#e9f0fa",
  stone: "#c9ced6",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;
export const radius = { sm: 8, md: 12, lg: 18, pill: 999 } as const;

export const type = {
  hero: { fontSize: 30, fontWeight: "700" },
  title: { fontSize: 20, fontWeight: "700" },
  heading: { fontSize: 15, fontWeight: "700" },
  body: { fontSize: 14 },
  label: { fontSize: 12, fontWeight: "500" },
  caption: { fontSize: 11 },
} as const;

/** A soft lift for cards; elevation on Android, a shadow elsewhere. */
export const lift: ViewStyle = Platform.select<ViewStyle>({
  android: { elevation: 1.5 },
  default: {
    shadowColor: "#0b2545",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
})!;

/** The plain card surface used across screens. */
export const card = {
  backgroundColor: colors.card,
  borderRadius: radius.lg,
  padding: space.lg,
  borderWidth: 1,
  borderColor: colors.border,
} as const;
