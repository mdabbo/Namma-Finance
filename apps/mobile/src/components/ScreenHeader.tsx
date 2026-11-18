import { StyleSheet, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Text } from "./AppText";
import { backGlyph, layoutDirection } from "../lib/layout";
import { colors } from "../lib/theme";

/**
 * The header of the Projects screens. It is drawn here, in JavaScript, because
 * the native stack header follows the phone's own layout direction and would
 * keep the back button on the wrong side until the app is restarted.
 */
export function ScreenHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      <View style={styles.row}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={styles.back} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.backGlyph}>{backGlyph(layoutDirection(i18n.language))}</Text>
          </TouchableOpacity>
        ) : null}
        {/* Sized to its text so it sits beside the back button in either direction. */}
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <View style={styles.fill} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: "#fff", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  row: { height: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 8 },
  back: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.chipBg },
  backGlyph: { fontSize: 26, lineHeight: 30, color: colors.brand },
  title: { flexShrink: 1, fontSize: 20, fontWeight: "700", color: colors.text },
  fill: { flex: 1 },
});
