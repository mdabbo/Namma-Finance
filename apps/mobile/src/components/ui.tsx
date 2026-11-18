import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Text } from "./AppText";
import { layoutDirection } from "../lib/layout";
import { card, colors, lift, radius, space, type } from "../lib/theme";

/**
 * The building blocks every screen is made of. They use start/end (never
 * left/right) so they mirror in Arabic, and they take Text from AppText so
 * Arabic gets Tajawal.
 */

export type IconName = keyof typeof Feather.glyphMap;
export type Tone = "brand" | "green" | "amber" | "red" | "blue" | "neutral";

const TONES: Record<Tone, { fg: string; bg: string }> = {
  brand: { fg: colors.brand, bg: colors.brandTint },
  green: { fg: colors.green, bg: colors.greenTint },
  amber: { fg: colors.amber, bg: colors.amberTint },
  red: { fg: colors.red, bg: colors.redTint },
  blue: { fg: colors.blue, bg: colors.blueTint },
  neutral: { fg: colors.subtle, bg: colors.chipBg },
};

export const toneColor = (tone: Tone) => TONES[tone].fg;

/** True when the app is laid out right to left. */
export function useIsRtl(): boolean {
  const { i18n } = useTranslation();
  return layoutDirection(i18n.language) === "rtl";
}

export function Icon({ name, size = 18, color = colors.subtle }: { name: IconName; size?: number; color?: string }) {
  return <Feather name={name} size={size} color={color} />;
}

/** A chevron that points toward the end edge (forward), whatever the direction. */
export function ForwardChevron({ color = colors.faint }: { color?: string }) {
  return <Icon name={useIsRtl() ? "chevron-left" : "chevron-right"} size={18} color={color} />;
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (!onPress) return <View style={[card, lift, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [card, lift, style, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

export function IconBadge({ name, tone = "brand", size = 36 }: { name: IconName; tone?: Tone; size?: number }) {
  const t = TONES[tone];
  return (
    <View style={[styles.iconBadge, { width: size, height: size, borderRadius: size / 2, backgroundColor: t.bg }]}>
      <Icon name={name} size={Math.round(size * 0.5)} color={t.fg} />
    </View>
  );
}

export function Badge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }]}>
      <View style={[styles.badgeDot, { backgroundColor: t.fg }]} />
      <Text style={[styles.badgeText, { color: t.fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function SectionHeader({ title, aside }: { title: string; aside?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {aside ? <Text style={styles.sectionAside}>{aside}</Text> : null}
    </View>
  );
}

export interface Segment {
  value: number;
  color: string;
}

/**
 * A bar split into parts of a whole, filled from the start edge. Parts are
 * clamped so a bad figure can never draw past the end.
 */
export function SegmentBar({ segments, total, height = 8, track = colors.divider }: { segments: Segment[]; total: number; height?: number; track?: string }) {
  let used = 0;
  return (
    <View style={[styles.track, { height, borderRadius: height / 2, backgroundColor: track }]}>
      {segments.map((segment, index) => {
        const share = total > 0 ? Math.max(0, Math.min(segment.value / total, 1 - used)) : 0;
        used += share;
        return share > 0 ? <View key={index} style={{ width: `${share * 100}%`, backgroundColor: segment.color }} /> : null;
      })}
    </View>
  );
}

export function LegendDot({ color, label, value }: { color: string; label: string; value?: string }) {
  return (
    <View style={styles.legend}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <View style={styles.legendText}>
        <Text style={styles.legendLabel} numberOfLines={1}>{label}</Text>
        {value ? <Text style={styles.legendValue} numberOfLines={1}>{value}</Text> : null}
      </View>
    </View>
  );
}

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function Empty({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={styles.empty}>
      <IconBadge name={icon} tone="neutral" size={48} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.85, transform: [{ scale: 0.995 }] },
  iconBadge: { alignItems: "center", justifyContent: "center" },
  badge: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.pill, alignSelf: "flex-start" },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 11, fontWeight: "700" },
  sectionHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginTop: space.sm, marginBottom: space.xs, paddingHorizontal: space.xs },
  sectionTitle: { ...type.heading, color: colors.text },
  sectionAside: { ...type.caption, color: colors.faint },
  track: { flexDirection: "row", overflow: "hidden", width: "100%" },
  legend: { flexDirection: "row", alignItems: "flex-start", gap: 6, flex: 1 },
  legendDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  legendText: { flex: 1 },
  legendLabel: { ...type.caption, color: colors.subtle },
  legendValue: { fontSize: 13, fontWeight: "700", color: colors.text },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.subtle },
  chipTextActive: { color: colors.onBrand },
  empty: { alignItems: "center", gap: space.md, paddingVertical: 48 },
  emptyText: { ...type.body, color: colors.subtle, textAlign: "center" },
});
