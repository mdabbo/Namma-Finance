import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatMinor, formatBp, type AppLocale } from "@mep/core";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { useWorkspace } from "../hooks/useWorkspace";
import { card, colors } from "../lib/theme";
import type { ProjectsStackParams } from "../navigation";

export function ProjectsScreen() {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language as AppLocale) ?? "ar";
  const navigation = useNavigation<NativeStackNavigationProp<ProjectsStackParams>>();
  const { data, refetch, isRefetching } = useWorkspace();

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.container}
      data={data?.projects ?? []}
      keyExtractor={(p) => String(p.project.id)}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />}
      ListEmptyComponent={<Text style={styles.empty}>{t("common.empty")}</Text>}
      renderItem={({ item: fin }) => (
        <TouchableOpacity
          style={[card, styles.row]}
          onPress={() => navigation.navigate("ProjectDetail", { projectId: fin.project.id })}
        >
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text style={styles.name} numberOfLines={1}>{fin.project.name}</Text>
              <Text style={styles.code}>{fin.project.code}</Text>
            </View>
            <Text style={[styles.status, statusColor(fin.project.status)]}>{t(`status.${fin.project.status}`)}</Text>
          </View>
          <Text style={styles.value}>
            {formatMinor(fin.contractValueMinor, fin.project.currency, locale, { compactFraction: true })}
          </Text>
          <View style={styles.barTrack}>
            <View style={[styles.barCertified, { width: `${Math.min(100, fin.certifiedRatioBp / 100)}%` }]} />
            <View style={[styles.barCollected, { width: `${Math.min(100, fin.collectionRatioBp / 100)}%` }]} />
          </View>
          <View style={styles.ratios}>
            <Text style={styles.ratio}>
              {t("projects.collected")}: <Text style={styles.ratioB}>{formatBp(fin.collectionRatioBp, locale)}</Text>
            </Text>
            <Text style={styles.ratio}>
              {t("projects.certified")}: <Text style={styles.ratioB}>{formatBp(fin.certifiedRatioBp, locale)}</Text>
            </Text>
          </View>
        </TouchableOpacity>
      )}
    />
  );
}

function statusColor(status: string) {
  if (status === "ACTIVE") return { color: colors.green };
  if (status === "ON_HOLD") return { color: colors.amber };
  if (status === "COMPLETED") return { color: colors.brand };
  return { color: colors.subtle };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 14, gap: 10 },
  empty: { textAlign: "center", color: colors.subtle, marginTop: 40 },
  row: { gap: 6 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  headText: { flex: 1 },
  name: { fontSize: 15, fontWeight: "700", color: colors.text },
  code: { fontSize: 11, color: colors.faint },
  status: { fontSize: 11, fontWeight: "700" },
  value: { fontSize: 17, fontWeight: "700", color: colors.text },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: "hidden" },
  barCertified: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: "#93c5fd", borderRadius: 4 },
  barCollected: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: colors.brand, borderRadius: 4 },
  ratios: { flexDirection: "row", justifyContent: "space-between" },
  ratio: { fontSize: 11, color: colors.subtle },
  ratioB: { fontWeight: "700", color: colors.text },
});
