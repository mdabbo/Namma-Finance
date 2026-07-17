import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { RouteProp } from "@react-navigation/native";
import { useRoute } from "@react-navigation/native";
import { formatIsoDate, formatMinor, isBillable, type AppLocale } from "@mep/core";
import { useWorkspace } from "../hooks/useWorkspace";
import { card, colors } from "../lib/theme";
import type { ProjectsStackParams } from "../navigation";

/** Read-only project sheet: totals, certificates, incoming payments. */
export function ProjectDetailScreen() {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language as AppLocale) ?? "ar";
  const route = useRoute<RouteProp<ProjectsStackParams, "ProjectDetail">>();
  const { data, refetch, isRefetching } = useWorkspace();

  const fin = data?.projects.find((p) => p.project.id === route.params.projectId);
  if (!fin) return <Text style={styles.empty}>{t("common.loading")}</Text>;

  const currency = fin.project.currency;
  const money = (minor: number) => formatMinor(minor, currency, locale, { compactFraction: true });
  const states = fin.contracts;
  const lifetime = states.reduce((s, c) => s + c.contract.valueMinor + c.figures.vatMinor, 0);
  const cashIn = states.reduce((s, c) => s + c.totalCashInMinor, 0);
  const certificates = states.flatMap((c) => c.certificates).sort((a, b) => b.certificate.date.localeCompare(a.certificate.date));

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />}
    >
      <View style={[card, styles.section]}>
        <Text style={styles.name}>{fin.project.name}</Text>
        <Text style={styles.code}>{fin.project.code} · {currency}</Text>
        <View style={styles.tiles}>
          <Tile label={t("dashboard.kpiContractValue")} value={money(fin.contractValueMinor)} />
          <Tile label={t("projects.certified")} value={money(fin.certifiedBaseMinor)} />
          <Tile label={t("projects.collected")} value={money(fin.totalPaidMinor)} color={colors.green} />
          <Tile label={t("clients.outstanding")} value={money(fin.outstandingMinor)} color={colors.amber} />
          <Tile label={t("payments.remainingBalance")} value={money(Math.max(0, lifetime - cashIn))} color={colors.amber} />
          <Tile label={t("dashboard.cashIn")} value={money(cashIn)} />
        </View>
      </View>

      <View style={[card, styles.section]}>
        <Text style={styles.sectionTitle}>{t("certificates.title")}</Text>
        {certificates.length === 0 && <Text style={styles.emptyRow}>{t("common.empty")}</Text>}
        {certificates.map((cs) => (
          <View key={cs.certificate.id} style={styles.certRow}>
            <View style={styles.certText}>
              <Text style={styles.certNumber} numberOfLines={1}>
                {cs.certificate.number}
                {cs.certificate.description ? ` — ${cs.certificate.description}` : ""}
              </Text>
              <Text style={styles.certDate}>{formatIsoDate(cs.certificate.date, locale)}</Text>
            </View>
            <View style={styles.certEnd}>
              <Text style={styles.certAmount}>{isBillable(cs.certificate.status) ? money(cs.breakdown.netPayableMinor) : money(cs.breakdown.baseMinor)}</Text>
              <Text style={[styles.certStatus, statusStyle(cs.certificate.status, cs.overdue)]}>
                {cs.overdue ? t("certificates.overdue") : t(`status.${cs.certificate.status}`)}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function statusStyle(status: string, overdue: boolean) {
  if (overdue) return { color: colors.red };
  if (status === "PAID") return { color: colors.green };
  if (status === "APPROVED") return { color: colors.brand };
  if (status === "SUBMITTED") return { color: colors.amber };
  return { color: colors.subtle };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 14, gap: 12 },
  empty: { textAlign: "center", color: colors.subtle, marginTop: 40 },
  emptyRow: { color: colors.subtle, fontSize: 12 },
  section: { gap: 8 },
  name: { fontSize: 18, fontWeight: "700", color: colors.text },
  code: { fontSize: 12, color: colors.faint },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
  tile: { flexBasis: "47%", flexGrow: 1 },
  tileLabel: { fontSize: 11, color: colors.subtle },
  tileValue: { fontSize: 15, fontWeight: "700", color: colors.text },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.text },
  certRow: { flexDirection: "row", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },
  certText: { flex: 1 },
  certNumber: { fontSize: 13, fontWeight: "600", color: colors.text },
  certDate: { fontSize: 11, color: colors.faint },
  certEnd: { alignItems: "flex-end" },
  certAmount: { fontSize: 13, fontWeight: "700", color: colors.text },
  certStatus: { fontSize: 11, fontWeight: "700" },
});
