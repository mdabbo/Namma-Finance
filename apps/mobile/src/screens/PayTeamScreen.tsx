import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { RouteProp } from "@react-navigation/native";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as Crypto from "expo-crypto";
import { currencyInfo, formatIsoDate, formatMinor, type AppLocale } from "@mep/core";
import { Text, TextInput } from "../components/AppText";
import { ScreenHeader } from "../components/ScreenHeader";
import { Card, Chip, Icon } from "../components/ui";
import { useWorkspace } from "../hooks/useWorkspace";
import { useTimeQueue } from "../hooks/useTimeQueue";
import { amountText, availableDue, paymentRow, validatePayment, type PaymentDraft, type PaymentError } from "../lib/team";
import { localIsoDate, openDates, sqliteUtc } from "../lib/timeEntryForm";
import { confirmAction } from "../lib/confirm";
import { colors, radius, space, type } from "../lib/theme";
import type { ProjectsStackParams } from "../navigation";

/**
 * Pays a team member from the phone. Only an earned payment, capped at what is
 * due now; it goes through the outbox like a time entry, and the desktop checks
 * it again when it syncs and adds the matching expense. Changing or voiding a
 * payment stays on the desktop.
 */
export function PayTeamScreen() {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language as AppLocale) ?? "ar";
  const navigation = useNavigation();
  const route = useRoute<RouteProp<ProjectsStackParams, "PayTeam">>();
  const { data } = useWorkspace();
  const queue = useTimeQueue();
  const today = localIsoDate(new Date());
  const [draft, setDraft] = useState<PaymentDraft>({ amount: "", date: today, note: "" });
  const [errors, setErrors] = useState<PaymentError[]>([]);

  const project = data?.projects.find((p) => p.project.id === route.params.projectId)?.project;
  const member = data?.team.get(route.params.projectId)?.find((m) => m.assignmentUuid === route.params.assignmentUuid);
  if (!project || !member) {
    return (
      <View style={styles.page}>
        <ScreenHeader title="" onBack={() => navigation.goBack()} />
        <Text style={styles.empty}>{t("common.loading")}</Text>
      </View>
    );
  }

  const exponent = currencyInfo(member.currency).exponent;
  const money = (minor: number) => formatMinor(minor, member.currency, locale);
  const available = availableDue(member, queue.state.items);
  const dates = openDates(today);
  const update = (patch: Partial<PaymentDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors([]);
  };
  const dateLabel = (date: string) => (date === dates[0] ? t("mobile.today") : date === dates[1] ? t("mobile.yesterday") : formatIsoDate(date, locale));

  const save = () => {
    const found = validatePayment(draft, member, queue.state.items, today, exponent);
    setErrors(found);
    if (found.length > 0) return;
    const row = paymentRow(draft, member, exponent, { uuid: Crypto.randomUUID(), createdAt: sqliteUtc(new Date()) });
    confirmAction(
      t("mobile.payConfirmTitle"),
      `${t("mobile.payConfirm", { amount: money(row.amount_minor), name: member.personName, date: formatIsoDate(row.date, locale) })}\n\n${t("mobile.payDesktopNote")}`,
      { yes: t("team.payStage"), no: t("common.cancel") },
      () => {
        queue.pay(row);
        navigation.goBack();
      },
    );
  };

  const message: Record<PaymentError, string> = {
    not_payable: t("mobile.archivedNoPay"),
    amount: t("mobile.errAmount"),
    exceeds_due: t("people.paymentExceedsDue", { due: money(available) }),
    date: t("mobile.errDate"),
    duplicate: t("people.duplicatePayment"),
  };

  return (
    <View style={styles.page}>
      <ScreenHeader title={t("mobile.payTitle", { name: member.personName })} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Card style={styles.summary}>
          <Text style={styles.project} numberOfLines={2}>{project.code} · {project.name}</Text>
          <Text style={styles.label}>{t("team.dueNow")}</Text>
          <Text style={styles.due}>{money(available)}</Text>
          <Text style={styles.hint}>{t("people.paidToDate")}: {money(member.paidMinor)} · {t("people.agreedAmount")}: {money(member.agreedMinor)}</Text>
        </Card>

        <Card style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>{t("mobile.amountLabel", { currency: member.currency })}</Text>
            <TextInput
              value={draft.amount}
              onChangeText={(amount) => update({ amount })}
              placeholder={t("mobile.amountPlaceholder")}
              placeholderTextColor={colors.faint}
              keyboardType="decimal-pad"
              style={[styles.input, (errors.includes("amount") || errors.includes("exceeds_due")) && styles.inputInvalid]}
              accessibilityLabel={t("mobile.amountLabel", { currency: member.currency })}
            />
            {available > 0 ? (
              <View style={styles.chips}>
                <Chip label={t("mobile.payFullDue")} active={draft.amount === amountText(available, exponent)} onPress={() => update({ amount: amountText(available, exponent) })} />
              </View>
            ) : null}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("common.date")}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {dates.map((date) => (
                <Chip key={date} label={dateLabel(date)} active={draft.date === date} onPress={() => update({ date })} />
              ))}
            </ScrollView>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("common.notes")}</Text>
            <TextInput value={draft.note} onChangeText={(note) => update({ note })} style={styles.input} accessibilityLabel={t("common.notes")} />
          </View>

          {errors.map((error) => (
            <Text key={error} style={styles.error}>{message[error]}</Text>
          ))}

          <Pressable onPress={save} disabled={!queue.loaded} accessibilityRole="button" style={({ pressed }) => [styles.primary, (pressed || !queue.loaded) && styles.pressed]}>
            <Icon name="send" size={18} color={colors.onBrand} />
            <Text style={styles.primaryText}>{t("team.payStage")}</Text>
          </Pressable>
          <Text style={styles.hint}>{t("mobile.payDesktopNote")}</Text>
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  container: { padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 },
  empty: { textAlign: "center", color: colors.subtle, marginTop: 40 },
  summary: { gap: 4 },
  project: { ...type.body, color: colors.subtle },
  due: { fontSize: 28, fontWeight: "700", color: colors.brand },
  form: { gap: space.lg },
  field: { gap: 6 },
  label: { ...type.label, color: colors.subtle },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  input: { minHeight: 48, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, fontSize: 16, color: colors.text },
  inputInvalid: { borderColor: colors.red },
  error: { ...type.label, color: colors.red },
  primary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, height: 50, borderRadius: radius.md, backgroundColor: colors.brand },
  pressed: { opacity: 0.8 },
  primaryText: { fontSize: 16, fontWeight: "700", color: colors.onBrand },
  hint: { ...type.caption, color: colors.faint },
});
