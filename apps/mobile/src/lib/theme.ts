/** Shared look for the mobile screens — matches the desktop's brand blue. */
export const colors = {
  brand: "#2563eb",
  bg: "#f1f5f9",
  card: "#ffffff",
  text: "#0f172a",
  subtle: "#64748b",
  faint: "#94a3b8",
  green: "#059669",
  amber: "#d97706",
  red: "#dc2626",
  border: "#e2e8f0",
  chipBg: "#eff6ff",
};

export const card = {
  backgroundColor: colors.card,
  borderRadius: 16,
  padding: 14,
  borderWidth: 1,
  borderColor: colors.border,
} as const;
