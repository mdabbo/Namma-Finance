import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSupabase, useWorkspace } from "../hooks/useWorkspace";
import { useReportingCurrency } from "../hooks/useReportingCurrency";
import { useAppLock } from "../hooks/useAppLock";
import { formatIsoDate, type AppLocale } from "@mep/core";
import { rateAgeDays, STALE_RATE_DAYS } from "../lib/fxRates";
import { formatRateMicro, parseRateMicro, REPORTING_CURRENCIES, suggestRate, type ReportingCurrency } from "../lib/reporting";
import { saveLanguage } from "../lib/supabase";
import { Text, TextInput } from "../components/AppText";
import { ScreenHeader } from "../components/ScreenHeader";
import { Card, Icon, IconBadge, SectionHeader, type IconName } from "../components/ui";
import { syncNativeDirection } from "../lib/nativeDirection";
import { colors, radius, space, type } from "../lib/theme";
import { APP_VERSION, RELEASE_CHANNEL } from "../generated/release";

/** The tables whose row counts explain an empty screen. */
const CHECKED_TABLES = ["projects", "contracts", "payment_certificates", "payments", "expenses", "people"] as const;
const TABLE_LABELS: Record<(typeof CHECKED_TABLES)[number], string> = {
  projects: "projects.title",
  contracts: "contracts.title",
  payment_certificates: "certificates.title",
  payments: "payments.title",
  expenses: "expenses.title",
  people: "people.title",
};

/**
 * Who is signed in, with which role, and how many rows the cloud returns to
 * them. An empty dashboard looks the same whether the desktop has not synced
 * or the login has no role; these counts tell the two apart on the phone.
 */
function useAccountCheck() {
  const client = useSupabase();
  return useQuery({
    queryKey: ["account-check"],
    queryFn: async () => {
      const { data: userData } = await client.auth.getUser();
      const user = userData.user;
      let role: string | null = null;
      if (user) {
        const { data } = await client.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
        role = (data as { role?: string } | null)?.role ?? null;
      }
      const counts = await Promise.all(
        CHECKED_TABLES.map(async (table) => {
          const { count, error } = await client.from(table).select("*", { count: "exact", head: true }).is("deleted_at", null);
          return { table, count: error ? null : count ?? 0 };
        }),
      );
      return { email: user?.email ?? null, role, counts };
    },
    staleTime: 60_000,
  });
}

export function SettingsScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const { t, i18n } = useTranslation();
  const client = useSupabase();
  const { data: account } = useAccountCheck();

  async function switchLanguage(lang: "ar" | "en") {
    // The layout flips at once (App.tsx reads the language); this only keeps
    // the phone's own direction in step for the next time the app is opened.
    await i18n.changeLanguage(lang);
    syncNativeDirection(lang);
    await saveLanguage(lang);
  }

  return (
    <View style={styles.page}>
      <ScreenHeader title={t("nav.settings")} />
      <ScrollView contentContainerStyle={styles.container}>
        <SectionHeader title={t("settings.language")} />
        <Card style={styles.segmented}>
          {(["ar", "en"] as const).map((lang) => {
            const active = i18n.language === lang;
            return (
              <Pressable
                key={lang}
                style={[styles.segment, active && styles.segmentActive]}
                onPress={() => void switchLanguage(lang)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {lang === "ar" ? t("settings.arabic") : t("settings.english")}
                </Text>
              </Pressable>
            );
          })}
        </Card>

        <CurrencySection />

        <LockSection />

        <SectionHeader title={t("mobile.account")} />
        <Card style={styles.group}>
          <InfoRow icon="user" label={t("mobile.signedInAs")} value={account?.email ?? "—"} ltrValue />
          <InfoRow
            icon="shield"
            label={t("mobile.role")}
            value={account ? (account.role ? t(`roles.${account.role}`) : t("mobile.noRole")) : "—"}
            warn={account != null && account.role == null}
            last
          />
        </Card>

        <SectionHeader title={t("mobile.dataOnPhone")} />
        <Card style={styles.group}>
          <Text style={styles.hint}>{t("mobile.dataOnPhoneHint")}</Text>
          <View style={styles.counts}>
            {(account?.counts ?? []).map(({ table, count }) => (
              <View key={table} style={styles.count}>
                <Text style={[styles.countValue, count === 0 && { color: colors.red }]}>{count == null ? "!" : count}</Text>
                <Text style={styles.countLabel} numberOfLines={1}>{t(TABLE_LABELS[table])}</Text>
              </View>
            ))}
          </View>
        </Card>

        <SectionHeader title={t("mobile.about")} />
        <Card style={styles.group}>
          <InfoRow icon="info" label={t("settings.applicationVersion")} value={APP_VERSION} ltrValue />
          <InfoRow icon="tag" label={t("settings.releaseChannel")} value={t(`settings.releaseChannels.${RELEASE_CHANNEL}`)} last />
        </Card>

        <Pressable
          style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.8 }]}
          onPress={() => {
            void client.auth.signOut().then(onSignedOut);
          }}
          accessibilityRole="button"
        >
          <Icon name="log-out" size={17} color={colors.red} />
          <Text style={styles.signOutText}>{t("settings.syncSignOut")}</Text>
        </Pressable>

        <Text style={styles.note}>{t("dashboard.consolidatedNote", { currency: "EGP" })}</Text>
      </ScrollView>
    </View>
  );
}

/**
 * The app lock: asks for the phone's own lock on reopen. Turning it on or off
 * asks for that lock too, so someone holding an unlocked app cannot switch it off.
 */
function LockSection() {
  const { t } = useTranslation();
  const lock = useAppLock();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <SectionHeader title={t("mobile.lockSetting")} />
      <Card style={styles.group}>
        <View style={styles.lockRow}>
          <IconBadge name="lock" tone="brand" size={32} />
          <Text style={styles.lockLabel}>{t("mobile.lockSettingLabel")}</Text>
          <Switch
            value={lock.enabled}
            disabled={!lock.available || busy}
            onValueChange={(on) => {
              setBusy(true);
              void lock.setEnabled(on).finally(() => setBusy(false));
            }}
            trackColor={{ true: colors.brand, false: colors.stone }}
            thumbColor={colors.card}
            accessibilityLabel={t("mobile.lockSettingLabel")}
          />
        </View>
        <Text style={styles.hint}>{lock.available ? t("mobile.lockSettingHint") : t("mobile.lockUnavailable")}</Text>
      </Card>
    </>
  );
}

/** Which currency the totals are shown in, and that currency's rate in EGP. */
function CurrencySection() {
  const { t, i18n } = useTranslation();
  const { currency, fxRateMicro, rateSource, rateUpdatedAt, valuation, setCurrency, setRate } = useReportingCurrency();
  const age = rateAgeDays(rateUpdatedAt, Date.now());
  const { data } = useWorkspace();
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    setDraft(currency !== "EGP" && fxRateMicro ? formatRateMicro(fxRateMicro) : "");
    setMessage(null);
  }, [currency, fxRateMicro]);

  const suggestion = currency === "EGP"
    ? null
    : suggestRate(currency, (data?.projects ?? []).map((fin) => ({
        code: fin.project.code,
        currency: fin.project.currency,
        fxRateMicro: fin.project.fxRateMicro,
        createdAt: fin.project.createdAt,
      })));

  async function save(code: ReportingCurrency, text: string) {
    const micro = parseRateMicro(text);
    if (micro == null) return setMessage({ text: t("mobile.invalidRate"), error: true });
    await setRate(code, micro);
    setMessage({ text: t("mobile.rateSaved"), error: false });
  }

  return (
    <>
      <SectionHeader title={t("mobile.reportingCurrency")} />
      <Card style={styles.currencyCard}>
        <View style={styles.segmentedInner}>
          {REPORTING_CURRENCIES.map((code) => {
            const active = currency === code;
            return (
              <Pressable
                key={code}
                style={[styles.segment, active && styles.segmentActive]}
                onPress={() => void setCurrency(code)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{code}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>{t("mobile.reportingCurrencyHint")}</Text>

        {currency !== "EGP" && rateSource === "desktop" && fxRateMicro ? (
          <View style={styles.rateBlock}>
            <Text style={styles.rateLabel}>{t("mobile.rateLabel", { currency })}</Text>
            <View style={styles.desktopRate}>
              <IconBadge name="monitor" tone="blue" size={32} />
              <View style={styles.desktopRateText}>
                <Text style={[styles.desktopRateValue, styles.ltr]}>{formatRateMicro(fxRateMicro)}</Text>
                <Text style={styles.hint}>
                  {t("mobile.desktopRate")}
                  {rateUpdatedAt ? ` · ${t("mobile.updated", { time: formatIsoDate(rateUpdatedAt.slice(0, 10), (i18n.language as AppLocale) ?? "ar") })}` : ""}
                </Text>
              </View>
            </View>
            {age != null && age >= STALE_RATE_DAYS ? (
              <Text style={[styles.rateMessage, { color: colors.amber }]}>{t("mobile.rateOld", { days: age })}</Text>
            ) : null}
            <Text style={styles.hint}>{t("mobile.desktopRateHint")}</Text>
          </View>
        ) : currency !== "EGP" ? (
          <View style={styles.rateBlock}>
            <Text style={styles.rateLabel}>{t("mobile.rateLabel", { currency })}</Text>
            <Text style={styles.hint}>{t("mobile.noDesktopRate")}</Text>
            <View style={styles.rateRow}>
              <TextInput
                style={styles.rateInput}
                value={draft}
                onChangeText={(text) => { setDraft(text); setMessage(null); }}
                keyboardType="decimal-pad"
                placeholder="12.85"
                placeholderTextColor={colors.faint}
                accessibilityLabel={t("mobile.rateLabel", { currency })}
              />
              <Pressable style={styles.saveButton} onPress={() => void save(currency, draft)} accessibilityRole="button">
                <Text style={styles.saveText}>{t("common.save")}</Text>
              </Pressable>
            </View>
            {suggestion && suggestion.fxRateMicro !== fxRateMicro ? (
              <Pressable style={styles.suggestion} onPress={() => void save(currency, formatRateMicro(suggestion.fxRateMicro))} accessibilityRole="button">
                <Icon name="corner-down-left" size={14} color={colors.blue} />
                <Text style={styles.suggestionText}>
                  {t("mobile.rateFromProject", { code: suggestion.code })}: {formatRateMicro(suggestion.fxRateMicro)} · {t("mobile.useThisRate")}
                </Text>
              </Pressable>
            ) : null}
            {message ? <Text style={[styles.rateMessage, message.error && { color: colors.red }]}>{message.text}</Text> : null}
            {!valuation ? <Text style={[styles.rateMessage, { color: colors.amber }]}>{t("mobile.rateNeeded", { currency })}</Text> : null}
          </View>
        ) : null}
      </Card>
    </>
  );
}

function InfoRow({ icon, label, value, last, warn, ltrValue }: { icon: IconName; label: string; value: string; last?: boolean; warn?: boolean; ltrValue?: boolean }) {
  return (
    <View style={[styles.infoRow, !last && styles.infoRowDivider]}>
      <IconBadge name={icon} tone={warn ? "red" : "brand"} size={32} />
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, warn && { color: colors.red }, ltrValue && styles.ltr]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  lockRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  lockLabel: { ...type.body, flex: 1, color: colors.text, fontWeight: "600" },
  page: { flex: 1, backgroundColor: colors.bg },
  container: { padding: space.lg, gap: space.sm, paddingBottom: space.xxl },
  segmented: { flexDirection: "row", padding: 4, gap: 4 },
  currencyCard: { padding: space.md, gap: space.sm },
  segmentedInner: { flexDirection: "row", gap: 4, backgroundColor: colors.chipBg, borderRadius: radius.md, padding: 4 },
  desktopRate: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.blueTint },
  desktopRateText: { flex: 1, gap: 2 },
  desktopRateValue: { fontSize: 20, fontWeight: "700", color: colors.text },
  rateBlock: { gap: space.sm, marginTop: space.xs },
  rateLabel: { ...type.label, color: colors.text },
  rateRow: { flexDirection: "row", gap: space.sm },
  rateInput: {
    flex: 1, height: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md,
    fontSize: 16, color: colors.text, backgroundColor: colors.card, writingDirection: "ltr", // ltr-content: a number
  },
  saveButton: { height: 44, paddingHorizontal: space.lg, borderRadius: radius.md, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  saveText: { color: colors.onBrand, fontWeight: "700", fontSize: 14 },
  suggestion: { flexDirection: "row", alignItems: "center", gap: 6 },
  suggestionText: { ...type.caption, color: colors.blue, fontWeight: "600", flexShrink: 1 },
  rateMessage: { ...type.caption, color: colors.green, fontWeight: "600" },
  segment: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: radius.md },
  segmentActive: { backgroundColor: colors.brand },
  segmentText: { fontSize: 14, fontWeight: "600", color: colors.subtle },
  segmentTextActive: { color: colors.onBrand },
  group: { paddingVertical: space.xs, paddingHorizontal: space.md },
  infoRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md },
  infoRowDivider: { borderBottomWidth: 1, borderBottomColor: colors.divider },
  infoLabel: { flex: 1, fontSize: 14, color: colors.text },
  infoValue: { maxWidth: "55%", fontSize: 13, fontWeight: "600", color: colors.subtle },
  ltr: { writingDirection: "ltr" }, // ltr-content: emails and version numbers
  hint: { ...type.caption, color: colors.subtle, paddingTop: space.md, lineHeight: 17 },
  counts: { flexDirection: "row", flexWrap: "wrap", paddingVertical: space.md, rowGap: space.md },
  count: { width: "33.33%", alignItems: "center", gap: 2 },
  countValue: { fontSize: 20, fontWeight: "700", color: colors.brand },
  countLabel: { ...type.caption, color: colors.faint },
  signOut: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, marginTop: space.lg,
    paddingVertical: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: "#f3c7c9", backgroundColor: colors.card,
  },
  signOutText: { color: colors.red, fontWeight: "700", fontSize: 15 },
  note: { ...type.caption, textAlign: "center", color: colors.faint, marginTop: space.md },
});
