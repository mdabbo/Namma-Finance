import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatMinor, type AppLocale } from "@mep/core";
import { useWorkspace } from "../hooks/useWorkspace";
import { card, colors } from "../lib/theme";

/** Office overview: consolidated KPIs (EGP), face values per currency, alerts. */
export function HomeScreen() {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language as AppLocale) ?? "ar";
  const { data, isLoading, refetch, isRefetching, error } = useWorkspace();

  const money = (minor: number, currency: string) =>
    formatMinor(minor, currency, locale, { compactFraction: true });

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />}
    >
      {error && <Text style={styles.error}>{(error as Error).message}</Text>}
      {isLoading && !data && <Text style={styles.loading}>{t("common.loading")}</Text>}
      {data && (
        <>
          <View style={styles.kpiGrid}>
            <Kpi label={t("dashboard.kpiContractValue")} value={money(data.kpis.contractValueEgp, "EGP")} />
            <Kpi label={t("dashboard.kpiRevenue")} value={money(data.kpis.revenueEgp, "EGP")} />
            <Kpi label={t("dashboard.kpiCollected")} value={money(data.kpis.collectedEgp, "EGP")} color={colors.green} />
            <Kpi
              label={t("dashboard.kpiOutstanding")}
              value={money(data.kpis.outstandingEgp, "EGP")}
              color={data.kpis.outstandingEgp > 0 ? colors.amber : undefined}
            />
            <Kpi label={t("dashboard.kpiExpenses")} value={money(data.kpis.expensesEgp, "EGP")} color={colors.red} />
            <Kpi
              label={t("dashboard.kpiProfit")}
              value={money(data.kpis.profitEgp, "EGP")}
              color={data.kpis.profitEgp >= 0 ? colors.green : colors.red}
            />
          </View>

          {data.byCurrency.length > 1 && (
            <View style={[card, styles.section]}>
              <Text style={styles.sectionTitle}>{t("dashboard.byCurrency")}</Text>
              {data.byCurrency.map(([code, g]) => (
                <View key={code} style={styles.currencyRow}>
                  <Text style={styles.currencyCode}>{code}</Text>
                  <Text style={styles.currencyFigures}>
                    {money(g.value, code)} · <Text style={{ color: colors.green }}>{money(g.collected, code)}</Text> ·{" "}
                    <Text style={{ color: colors.amber }}>{money(g.outstanding, code)}</Text>
                  </Text>
                </View>
              ))}
            </View>
          )}

          {data.readyToCollect.length > 0 && (
            <View style={[card, styles.section, styles.alertGreen]}>
              <Text style={[styles.sectionTitle, { color: colors.green }]}>{t("dashboard.readyToCollect")}</Text>
              {data.readyToCollect.map((item) => (
                <AlertRow key={item.key} title={item.projectName} sub={item.titles.join(" · ")} amount={money(item.amountMinor, item.currency)} />
              ))}
            </View>
          )}

          {data.teamPayables.length > 0 && (
            <View style={[card, styles.section, styles.alertBlue]}>
              <Text style={[styles.sectionTitle, { color: colors.brand }]}>{t("dashboard.teamPayables")}</Text>
              {data.teamPayables.map((item) => (
                <AlertRow
                  key={item.key}
                  title={item.personName}
                  sub={`${item.projectCode} · ${item.titles.join(" · ")}`}
                  amount={money(item.amountMinor, item.currency)}
                />
              ))}
            </View>
          )}

          {data.overdueCount > 0 && (
            <View style={[card, styles.section, styles.alertRed]}>
              <Text style={[styles.sectionTitle, { color: colors.red }]}>
                {t("dashboard.kpiOverdue")}: {data.overdueCount}
              </Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={[card, styles.kpi]}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function AlertRow({ title, sub, amount }: { title: string; sub: string; amount: string }) {
  return (
    <View style={styles.alertRow}>
      <View style={styles.alertText}>
        <Text style={styles.alertTitle} numberOfLines={1}>{title}</Text>
        {sub !== "" && <Text style={styles.alertSub} numberOfLines={1}>{sub}</Text>}
      </View>
      <Text style={styles.alertAmount}>{amount}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 14, gap: 12 },
  loading: { textAlign: "center", color: colors.subtle, marginTop: 40 },
  error: { color: colors.red, textAlign: "center" },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  kpi: { flexBasis: "47%", flexGrow: 1 },
  kpiLabel: { fontSize: 11, color: colors.subtle },
  kpiValue: { fontSize: 17, fontWeight: "700", color: colors.text, marginTop: 2 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.text },
  currencyRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  currencyCode: { fontWeight: "700", color: colors.text, fontSize: 13 },
  currencyFigures: { color: colors.subtle, fontSize: 12 },
  alertGreen: { borderColor: "#a7f3d0", backgroundColor: "#ecfdf5" },
  alertBlue: { borderColor: "#bfdbfe", backgroundColor: "#eff6ff" },
  alertRed: { borderColor: "#fecaca", backgroundColor: "#fef2f2" },
  alertRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  alertText: { flex: 1 },
  alertTitle: { fontSize: 13, fontWeight: "600", color: colors.text },
  alertSub: { fontSize: 11, color: colors.subtle },
  alertAmount: { fontSize: 13, fontWeight: "700", color: colors.text },
});
