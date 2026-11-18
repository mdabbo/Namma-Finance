import { useMemo, useState } from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBp, formatMinor, type AppLocale, type ProjectFinancials } from "@mep/core";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { useWorkspace } from "../hooks/useWorkspace";
import { Text, TextInput } from "../components/AppText";
import { ScreenHeader } from "../components/ScreenHeader";
import { Badge, Card, Chip, Empty, ForwardChevron, Icon, LegendDot, SegmentBar } from "../components/ui";
import { projectStatusTone } from "../lib/status";
import { colors, radius, space, type } from "../lib/theme";
import type { ProjectsStackParams } from "../navigation";

type Filter = "ALL" | "ACTIVE" | "ON_HOLD" | "COMPLETED";
const FILTERS: Filter[] = ["ALL", "ACTIVE", "ON_HOLD", "COMPLETED"];
const STATUS_ORDER: Record<string, number> = { ACTIVE: 0, ON_HOLD: 1, COMPLETED: 2 };

export function ProjectsScreen() {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language as AppLocale) ?? "ar";
  const navigation = useNavigation<NativeStackNavigationProp<ProjectsStackParams>>();
  const { data, refetch, isRefetching } = useWorkspace();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");

  const projects = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.projects ?? [])
      .filter((fin) => filter === "ALL" || fin.project.status === filter)
      .filter((fin) => !q || fin.project.name.toLowerCase().includes(q) || fin.project.code.toLowerCase().includes(q))
      .sort((a, b) => (STATUS_ORDER[a.project.status] ?? 9) - (STATUS_ORDER[b.project.status] ?? 9) || b.contractValueEgp - a.contractValueEgp);
  }, [data, query, filter]);

  const count = (f: Filter) => (data?.projects ?? []).filter((fin) => f === "ALL" || fin.project.status === f).length;

  return (
    <View style={styles.screen}>
      <ScreenHeader title={t("nav.projects")} />
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.container}
        data={projects}
        keyExtractor={(fin) => String(fin.project.id)}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.brand} />}
        ListHeaderComponent={
          <View style={styles.controls}>
            <View style={styles.search}>
              <Icon name="search" size={17} color={colors.faint} />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder={t("mobile.searchProjects")}
                placeholderTextColor={colors.faint}
                autoCorrect={false}
                returnKeyType="search"
              />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {FILTERS.map((f) => (
                <Chip
                  key={f}
                  label={`${f === "ALL" ? t("common.all") : t(`status.${f}`)} · ${count(f)}`}
                  active={filter === f}
                  onPress={() => setFilter(f)}
                />
              ))}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={data ? <Empty icon="search" text={t("mobile.noResults")} /> : <Text style={styles.loading}>{t("common.loading")}</Text>}
        renderItem={({ item }) => (
          <ProjectCard fin={item} locale={locale} onPress={() => navigation.navigate("ProjectDetail", { projectId: item.project.id })} />
        )}
      />
    </View>
  );
}

function ProjectCard({ fin, locale, onPress }: { fin: ProjectFinancials; locale: AppLocale; onPress: () => void }) {
  const { t } = useTranslation();
  const currency = fin.project.currency;
  const money = (minor: number) => formatMinor(minor, currency, locale, { compactFraction: true });
  return (
    <Card onPress={onPress} style={styles.card}>
      <View style={styles.head}>
        <View style={styles.code}><Text style={styles.codeText}>{fin.project.code}</Text></View>
        <Badge label={t(`status.${fin.project.status}`)} tone={projectStatusTone(fin.project.status)} />
        <View style={styles.spacer} />
        <ForwardChevron />
      </View>
      <Text style={styles.name} numberOfLines={2}>{fin.project.name}</Text>
      <View style={styles.valueRow}>
        <Text style={styles.value}>{money(fin.contractValueMinor)}</Text>
        <Text style={styles.ratio}>{t("projects.certified")} {formatBp(fin.certifiedRatioBp, locale)}</Text>
      </View>
      <SegmentBar
        total={fin.contractValueMinor}
        segments={[
          { value: fin.totalPaidMinor, color: colors.green },
          { value: Math.max(0, fin.certifiedBaseMinor - fin.totalPaidMinor), color: colors.amber },
        ]}
      />
      <View style={styles.legendRow}>
        <LegendDot color={colors.green} label={t("projects.collected")} value={money(fin.totalPaidMinor)} />
        <LegendDot color={colors.amber} label={t("clients.outstanding")} value={money(fin.outstandingMinor)} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  list: { flex: 1 },
  container: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  controls: { gap: space.md, marginBottom: space.xs },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space.md, height: 44 },
  searchInput: { flex: 1, fontSize: 14, color: colors.text, paddingVertical: 0 },
  chips: { gap: space.sm, paddingEnd: space.lg },
  loading: { textAlign: "center", color: colors.subtle, marginTop: 40 },
  card: { gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  code: { backgroundColor: colors.chipBg, borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 2 },
  codeText: { fontSize: 11, fontWeight: "700", color: colors.subtle, letterSpacing: 0.3 },
  spacer: { flex: 1 },
  name: { ...type.heading, fontSize: 16, color: colors.text },
  valueRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.sm },
  value: { fontSize: 18, fontWeight: "700", color: colors.brand },
  ratio: { ...type.caption, color: colors.subtle },
  legendRow: { flexDirection: "row", gap: space.md, marginTop: 2 },
});
