import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { RouteProp } from "@react-navigation/native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { formatBp, formatIsoDate, formatMinor, isBillable, type AppLocale } from "@mep/core";
import { useWorkspace } from "../hooks/useWorkspace";
import { Text } from "../components/AppText";
import { ScreenHeader } from "../components/ScreenHeader";
import { Badge, Card, Empty, IconBadge, LegendDot, SectionHeader, SegmentBar } from "../components/ui";
import { certificateStatusTone, projectStatusTone } from "../lib/status";
import { colors, lift, radius, space, type } from "../lib/theme";
import type { ProjectsStackParams } from "../navigation";

const DAY = 86_400_000;

/** One project: where its money stands, and every certificate with its state. */
export function ProjectDetailScreen() {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language as AppLocale) ?? "ar";
  const route = useRoute<RouteProp<ProjectsStackParams, "ProjectDetail">>();
  const navigation = useNavigation();
  const { data, refetch, isRefetching } = useWorkspace();

  const fin = data?.projects.find((p) => p.project.id === route.params.projectId);
  if (!fin) {
    return (
      <View style={styles.page}>
        <ScreenHeader title="" onBack={() => navigation.goBack()} />
        <Text style={styles.empty}>{t("common.loading")}</Text>
      </View>
    );
  }

  const currency = fin.project.currency;
  const money = (minor: number) => formatMinor(minor, currency, locale, { compactFraction: true });
  const states = fin.contracts;
  const lifetime = states.reduce((s, c) => s + c.contract.valueMinor + c.figures.vatMinor, 0);
  const cashIn = states.reduce((s, c) => s + c.totalCashInMinor, 0);
  const retentionHeld = states.reduce((s, c) => s + c.retentionHeldMinor, 0);
  const certificates = states.flatMap((c) => c.certificates).sort((a, b) => b.certificate.date.localeCompare(a.certificate.date));
  const uncertified = Math.max(0, fin.contractValueMinor - fin.certifiedBaseMinor);
  const today = Date.now();

  return (
    <View style={styles.page}>
      <ScreenHeader title={fin.project.code} onBack={() => navigation.goBack()} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.brand} />}
      >
        <View style={[styles.hero, lift]}>
          <View style={styles.heroHead}>
            <Badge label={t(`status.${fin.project.status}`)} tone={projectStatusTone(fin.project.status)} />
            <Text style={styles.heroCurrency}>{currency}</Text>
          </View>
          <Text style={styles.heroName}>{fin.project.name}</Text>
          <Text style={styles.heroLabel}>{t("dashboard.kpiContractValue")}</Text>
          <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit>{money(fin.contractValueMinor)}</Text>
          <SegmentBar
            total={fin.contractValueMinor}
            track="rgba(255,255,255,0.16)"
            segments={[
              { value: fin.totalPaidMinor, color: "#34d399" },
              { value: Math.max(0, fin.certifiedBaseMinor - fin.totalPaidMinor), color: colors.accent },
            ]}
          />
          <View style={styles.heroLegend}>
            <HeroLegend color="#34d399" label={t("projects.collected")} value={formatBp(fin.collectionRatioBp, locale)} />
            <HeroLegend color={colors.accent} label={t("projects.certified")} value={formatBp(fin.certifiedRatioBp, locale)} />
          </View>
        </View>

        <View style={styles.tiles}>
          <Figure label={t("projects.collected")} value={money(fin.totalPaidMinor)} color={colors.green} />
          <Figure label={t("clients.outstanding")} value={money(fin.outstandingMinor)} color={fin.outstandingMinor > 0 ? colors.amber : undefined} />
          <Figure label={t("mobile.uncertified")} value={money(uncertified)} />
          <Figure label={t("payments.remainingBalance")} value={money(Math.max(0, lifetime - cashIn))} />
          <Figure label={t("dashboard.cashIn")} value={money(cashIn)} />
          <Figure label={t("contracts.retentionHeld")} value={money(retentionHeld)} />
        </View>

        <SectionHeader title={t("certificates.title")} aside={t("mobile.itemsCount", { count: certificates.length })} />
        {certificates.length === 0 ? (
          <Card><Empty icon="file" text={t("common.empty")} /></Card>
        ) : (
          <Card style={styles.list}>
            {certificates.map((cs, index) => {
              const billable = isBillable(cs.certificate.status);
              const amount = billable ? cs.breakdown.netPayableMinor : cs.breakdown.baseMinor;
              const paidShare = billable && amount > 0 ? cs.paidMinor / amount : 0;
              const daysLate = cs.overdue && cs.dueDate ? Math.max(1, Math.floor((today - Date.parse(cs.dueDate)) / DAY)) : 0;
              const tone = certificateStatusTone(cs.certificate.status, cs.overdue);
              return (
                <View key={cs.certificate.id} style={[styles.cert, index === certificates.length - 1 && styles.certLast]}>
                  <IconBadge name={cs.certificate.status === "PAID" ? "check" : cs.overdue ? "alert-circle" : "file-text"} tone={tone} size={34} />
                  <View style={styles.certBody}>
                    <View style={styles.certTop}>
                      <Text style={styles.certNumber} numberOfLines={1}>{cs.certificate.number}</Text>
                      <Text style={styles.certAmount}>{money(amount)}</Text>
                    </View>
                    {cs.certificate.description ? <Text style={styles.certDesc} numberOfLines={1}>{cs.certificate.description}</Text> : null}
                    <View style={styles.certMeta}>
                      <Badge label={cs.overdue ? t("certificates.overdue") : t(`status.${cs.certificate.status}`)} tone={tone} />
                      <Text style={styles.certDate}>
                        {cs.overdue
                          ? t("mobile.overdueBy", { days: daysLate })
                          : cs.dueDate && cs.certificate.status !== "PAID" && billable
                            ? t("mobile.dueOn", { date: formatIsoDate(cs.dueDate, locale) })
                            : formatIsoDate(cs.certificate.date, locale)}
                      </Text>
                    </View>
                    {billable && cs.certificate.status !== "PAID" && cs.paidMinor > 0 ? (
                      <View style={styles.certPaid}>
                        <SegmentBar total={1} height={4} segments={[{ value: paidShare, color: colors.green }]} />
                        <LegendDot color={colors.green} label={t("projects.collected")} value={money(cs.paidMinor)} />
                      </View>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

function HeroLegend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <View style={styles.heroLegendItem}>
      <View style={[styles.heroDot, { backgroundColor: color }]} />
      <Text style={styles.heroLegendLabel}>{label}</Text>
      <Text style={styles.heroLegendValue}>{value}</Text>
    </View>
  );
}

function Figure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Card style={styles.figure}>
      <Text style={styles.figureLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.figureValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  screen: { flex: 1 },
  container: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  empty: { textAlign: "center", color: colors.subtle, marginTop: 40 },

  hero: { backgroundColor: colors.brand, borderRadius: radius.lg + 4, padding: space.xl, gap: space.sm },
  heroHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heroCurrency: { ...type.caption, color: colors.onBrandSubtle, fontWeight: "700", letterSpacing: 1 },
  heroName: { ...type.title, color: colors.onBrand },
  heroLabel: { ...type.label, color: colors.onBrandSubtle, marginTop: space.sm },
  heroValue: { ...type.hero, fontSize: 26, color: colors.onBrand, marginBottom: space.xs },
  heroLegend: { flexDirection: "row", gap: space.lg, marginTop: 2 },
  heroLegendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  heroDot: { width: 8, height: 8, borderRadius: 4 },
  heroLegendLabel: { ...type.caption, color: colors.onBrandSubtle },
  heroLegendValue: { ...type.caption, color: colors.onBrand, fontWeight: "700" },

  tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  figure: { flexBasis: "47%", flexGrow: 1, padding: space.md, gap: 4 },
  figureLabel: { ...type.caption, color: colors.subtle },
  figureValue: { fontSize: 15, fontWeight: "700", color: colors.text },

  list: { paddingVertical: space.xs, paddingHorizontal: space.md },
  cert: { flexDirection: "row", gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  certLast: { borderBottomWidth: 0 },
  certBody: { flex: 1, gap: 4 },
  certTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: space.sm },
  certNumber: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.text },
  certAmount: { fontSize: 14, fontWeight: "700", color: colors.text },
  certDesc: { ...type.caption, color: colors.subtle },
  certMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, marginTop: 2 },
  certDate: { ...type.caption, color: colors.faint },
  certPaid: { gap: 6, marginTop: 6 },
});
