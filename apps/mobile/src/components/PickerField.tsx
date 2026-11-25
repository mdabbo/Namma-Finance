import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "./AppText";
import { Icon } from "./ui";
import { layoutDirection } from "../lib/layout";
import { colors, radius, space, type } from "../lib/theme";
import type { Option } from "../lib/timeEntriesCloud";

/**
 * A form field that opens a searchable list. Used for people, projects and
 * stages, which can be too many for a row of chips.
 */
export function PickerField({
  label,
  value,
  options,
  onChange,
  placeholder,
  invalid,
  allowNone,
}: {
  label: string;
  value: string | null;
  options: Option[];
  onChange: (id: string | null) => void;
  placeholder: string;
  invalid?: boolean;
  /** The label of a "no choice" row at the top, when the field may be empty. */
  allowNone?: string;
}) {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.id === value) ?? null;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? options.filter((option) => option.label.toLowerCase().includes(q) || (option.hint ?? "").toLowerCase().includes(q))
      : options;
    return allowNone ? [{ id: "", label: allowNone }, ...matches] : matches;
  }, [options, query, allowNone]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={[styles.box, invalid && styles.boxInvalid]}
      >
        <View style={styles.boxText}>
          <Text style={[styles.value, !selected && styles.placeholder]} numberOfLines={1}>
            {selected ? selected.label : value === null && allowNone ? allowNone : placeholder}
          </Text>
          {selected?.hint ? <Text style={styles.hint}>{selected.hint}</Text> : null}
        </View>
        <Icon name="chevron-down" size={18} color={colors.faint} />
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={close}>
        {/* A Modal is a new native root: the app root's direction does not reach it. */}
        <View style={[styles.sheet, { paddingTop: insets.top, paddingBottom: insets.bottom, direction: layoutDirection(i18n.language) }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{label}</Text>
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel={t("common.close")} hitSlop={8} style={styles.closeButton}>
              <Icon name="x" size={20} color={colors.brand} />
            </Pressable>
          </View>
          <View style={styles.search}>
            <Icon name="search" size={16} color={colors.faint} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("common.search")}
              placeholderTextColor={colors.faint}
              style={styles.searchInput}
              autoCorrect={false}
            />
          </View>
          <FlatList
            data={shown}
            keyExtractor={(option) => option.id || "none"}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const active = (item.id || null) === value;
              return (
                <Pressable
                  onPress={() => {
                    onChange(item.id || null);
                    close();
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <View style={styles.boxText}>
                    <Text style={[styles.rowLabel, active && styles.rowActive]} numberOfLines={2}>{item.label}</Text>
                    {item.hint ? <Text style={styles.hint}>{item.hint}</Text> : null}
                  </View>
                  {active ? <Icon name="check" size={18} color={colors.brand} /> : null}
                </Pressable>
              );
            }}
            ListEmptyComponent={<Text style={styles.empty}>{t("mobile.noResults")}</Text>}
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { ...type.label, color: colors.subtle },
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 48,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  boxInvalid: { borderColor: colors.red },
  boxText: { flex: 1 },
  value: { ...type.body, color: colors.text, fontWeight: "600" },
  placeholder: { color: colors.faint, fontWeight: "400" },
  hint: { ...type.caption, color: colors.faint },
  sheet: { flex: 1, backgroundColor: colors.bg },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, height: 56, backgroundColor: colors.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sheetTitle: { ...type.title, color: colors.text },
  closeButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.chipBg },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, margin: space.lg, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  searchInput: { flex: 1, height: 44, ...type.body, color: colors.text },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider, backgroundColor: colors.card },
  rowPressed: { backgroundColor: colors.chipBg },
  rowLabel: { ...type.body, color: colors.text },
  rowActive: { color: colors.brand, fontWeight: "700" },
  empty: { ...type.body, color: colors.subtle, textAlign: "center", padding: space.xl },
});
