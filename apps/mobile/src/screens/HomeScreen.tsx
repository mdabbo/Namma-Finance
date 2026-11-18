import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { formatBp, formatMinor, type AppLocale } from "@mep/core";
import { useWorkspace } from "../hooks/useWorkspace";
import { Text } from "../components/AppText";
import { BrandLogo } from "../components/BrandLogo";
import { Badge, Card, Empty, IconBadge, LegendDot, SectionHeader, SegmentBar, type IconName, type Tone } from "../components/ui";
import { colors, lift, radius, space, type } from "../lib/theme";

/** The office at a glance: what is contracted, what came in, what needs a hand. */
export function HomeScreen() {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language as AppLocale) ?? "ar";
  const insets = useSafeAreaInsets();
  const { data, isLoading, refetch, isRefetching, error, dataUpdatedAt } = useWorkspace();

  const reportCurrency = data?.currency ?? "EGP";
  const money = (minor: number, currency = reportCurrency) => formatMinor(minor, currency, locale, { compactFraction: true });
  const updated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString(locale === "ar" ? "ar-EG" : "en-GB", { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + space.md }]}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.brand} />}
    >
      <View style={styles.topBar}>
        <View style={styles.brandRow}>
          <BrandLogo variant="wordmark" height={20} />
          <Text style={styles.brandSub}>{updated ? t("mobile.updated", { time: updated }) : t("common.appName")}</Text>
        </View>
      </View>

      {error ? (
        <Card style={styles.errorCard}>
          <IconBadge name="alert-triangle" tone="red" />
          <Text style={styles.errorText}>{(error as Error).message}</Text>
        </Card>
      ) : null}
      {isLoading && !data ? <Text style={styles.loading}>{t("common.loading")}</Text> : null}

      {data ? (
        <>
          {/* Hero: the whole portfolio, and how much of it has been certified. */}
          <View style={[styles.hero, lift]}>
            <Text style={styles.heroLabel}>{t("dashboard.kpiContractValue")}</Text>
            <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit>{money(data.kpis.contractValueEgp)}</Text>
            <View style={styles.heroProgressHead}>
              <Text style={styles.heroCaption}>{t("projects.certified")}</Text>
              <Text style={styles.heroCaptionStrong}>
                {formatBp(ratio(data.kpis.revenueEgp, data.kpis.contractValueEgp), locale)}
              </Text>
            </View>
            <SegmentBar
              total={data.kpis.contractValueEgp}
              segments={[{ value: data.kpis.revenueEgp, color: colors.accent }]}
              track="rgba(255,255,255,0.16)"
            />
            <View style={styles.heroStats}>
              <HeroStat label={t("dashboard.kpiCollected")} value={money(data.kpis.collectedEgp)} />
              <View style={styles.heroDivider} />
              <HeroStat label={t("dashboard.kpiOutstanding")} value={money(data.kpis.outstandingEgp)} />
            </View>
          </View>

          <View style={styles.tiles}>
            <Tile icon="file-text" tone="blue" label={t("dashboard.kpiRevenue")} value={money(data.kpis.revenueEgp)} />
            <Tile icon="trending-down" tone="red" label={t("dashboard.kpiExpenses")} value={money(data.kpis.expensesEgp)} />
            <Tile
              icon="trending-up"
              tone={data.kpis.profitEgp >= 0 ? "green" : "red"}
              label={t("dashboard.kpiProfit")}
              value={money(data.kpis.profitEgp)}
              note={`${t("mobile.margin")} ${formatBp(data.kpis.marginBp, locale)}`}
            />
            <Tile
              icon="clock"
              tone={data.overdueCount > 0 ? "red" : "neutral"}
              label={t("dashboard.kpiOverdue")}
              value={String(data.overdueCount)}
            />
          </View>

          <SectionHeader title={t("mobile.needsAttention")} />
          {data.overdueCount === 0 && data.readyToCollect.length === 0 && data.teamPayables.length === 0 ? (
            <Card><Empty icon="check-circle" text={t("mobile.allClear")} /></Card>
          ) : (
            <Card style={styles.list}>
              {data.overdueCount > 0 ? (
                <AttentionRow
                  icon="alert-circle"
                  tone="red"
                  title={t("certificates.overdue")}
                  sub={t("mobile.overdueHint")}
                  end={<Badge tone="red" label={String(data.overdueCount)} />}
                />
              ) : null}
              {data.readyToCollect.map((item) => (
                <AttentionRow
                  key={item.key}
                  icon="flag"
                  tone="green"
                  title={item.projectName}
                  sub={item.titles.join(" · ") || t("mobile.readyToCollectHint")}
                  end={<Text style={[styles.rowAmount, { color: colors.green }]}>{money(item.amountMinor, item.currency)}</Text>}
                />
              ))}
              {data.teamPayables.map((item) => (
                <AttentionRow
                  key={item.key}
                  initials={initialsOf(item.personName)}
                  tone="blue"
                  title={item.personName}
                  sub={`${item.projectCode} · ${t("mobile.teamPayablesHint")}`}
                  end={<Text style={styles.rowAmount}>{money(item.amountMinor, item.currency)}</Text>}
                />
              ))}
            </Card>
          )}

          {data.byCurrency.length > 0 ? (
            <>
              <SectionHeader title={t("dashboard.byCurrency")} />
              {data.byCurrency.map(([code, g]) => (
                <Card key={code} style={styles.currencyCard}>
                  <View style={styles.currencyHead}>
                    <Badge label={code} tone="brand" />
                    <Text style={styles.currencyValue}>{money(g.value, code)}</Text>
                  </View>
                  <SegmentBar
                    total={g.value}
                    segments={[
                      { value: g.collected, color: colors.green },
                      { value: g.outstanding, color: colors.amber },
                    ]}
                  />
                  <View style={styles.legendRow}>
                    <LegendDot color={colors.green} label={t("dashboard.kpiCollected")} value={money(g.collected, code)} />
                    <LegendDot color={colors.amber} label={t("dashboard.kpiOutstanding")} value={money(g.outstanding, code)} />
                  </View>
                </Card>
              ))}
            </>
          ) : null}
          <Text style={styles.footnote}>{t("dashboard.consolidatedNote", { currency: reportCurrency })}</Text>
        </>
      ) : null}
    </ScrollView>
  );
}

const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) : 0);

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.heroStat}>
      <Text style={styles.heroCaption}>{label}</Text>
      <Text style={styles.heroStatValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  );
}

function Tile({ icon, tone, label, value, note }: { icon: IconName; tone: Tone; label: string; value: string; note?: string }) {
  return (
    <Card style={styles.tile}>
      <IconBadge name={icon} tone={tone} size={32} />
      <Text style={styles.tileLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {note ? <Text style={styles.tileNote}>{note}</Text> : null}
    </Card>
  );
}

function AttentionRow({ icon, initials, tone, title, sub, end }: { icon?: IconName; initials?: string; tone: Tone; title: string; sub: string; end: React.ReactNode }) {
  return (
    <View style={styles.row}>
      {initials ? (
        <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
      ) : (
        <IconBadge name={icon ?? "info"} tone={tone} />
      )}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>{sub}</Text>
      </View>
      {end}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: space.xs },
  brandRow: { gap: 6, alignItems: "flex-start" },
  brandSub: { ...type.caption, color: colors.faint },
  loading: { textAlign: "center", color: colors.subtle, marginTop: 40 },
  errorCard: { flexDirection: "row", alignItems: "center", gap: space.md },
  errorText: { flex: 1, color: colors.red, fontSize: 13 },

  hero: { backgroundColor: colors.brand, borderRadius: radius.lg + 4, padding: space.xl, gap: space.sm },
  heroLabel: { ...type.label, color: colors.onBrandSubtle },
  heroValue: { ...type.hero, color: colors.onBrand },
  heroProgressHead: { flexDirection: "row", justifyContent: "space-between", marginTop: space.sm },
  heroCaption: { ...type.caption, color: colors.onBrandSubtle },
  heroCaptionStrong: { ...type.caption, color: colors.onBrand, fontWeight: "700" },
  heroStats: { flexDirection: "row", alignItems: "stretch", marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.12)" },
  heroStat: { flex: 1, gap: 2 },
  heroDivider: { width: 1, backgroundColor: "rgba(255,255,255,0.12)", marginHorizontal: space.md },
  heroStatValue: { fontSize: 17, fontWeight: "700", color: colors.onBrand },

  tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  tile: { flexBasis: "47%", flexGrow: 1, gap: 6, padding: space.md + 2 },
  tileLabel: { ...type.caption, color: colors.subtle, marginTop: 4 },
  tileValue: { fontSize: 17, fontWeight: "700", color: colors.text },
  tileNote: { ...type.caption, color: colors.faint },

  list: { paddingVertical: space.xs, paddingHorizontal: space.md },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { ...type.caption, color: colors.subtle, marginTop: 1 },
  rowAmount: { fontSize: 14, fontWeight: "700", color: colors.text },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.blueTint, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 13, fontWeight: "700", color: colors.blue },

  currencyCard: { gap: space.md },
  currencyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  currencyValue: { fontSize: 17, fontWeight: "700", color: colors.text },
  legendRow: { flexDirection: "row", gap: space.md },
  footnote: { ...type.caption, color: colors.faint, textAlign: "center", marginTop: space.sm },
});
