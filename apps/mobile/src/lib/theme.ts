/** Shared look for the mobile screens — mirrors the desktop DABWORKS tokens. */
export const colors = {
  brand: "#0b2545",
  bg: "#f3f5f8",
  card: "#ffffff",
  text: "#1c2433",
  subtle: "#5c6673",
  faint: "#99a2ae",
  green: "#059669",
  amber: "#d97706",
  accent: "#f36c21", // DAB Orange
  red: "#dc2626",
  border: "#e3e7ec",
  chipBg: "#f2f6fa",
};

export const card = {
  backgroundColor: colors.card,
  borderRadius: 16,
  padding: 14,
  borderWidth: 1,
  borderColor: colors.border,
} as const;
