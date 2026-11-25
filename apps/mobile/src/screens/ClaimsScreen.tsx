import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { formatIsoDate, formatMinor, type AppLocale } from "@mep/core";
import { Text, TextInput } from "../components/AppText";
import { PickerField } from "../components/PickerField";
import { ScreenHeader } from "../components/ScreenHeader";
import { Badge, Card, Chip, Empty, Icon, IconBadge, SectionHeader, type Tone } from "../components/ui";
import { useSupabase } from "../hooks/useWorkspace";
import { useTimeQueue } from "../hooks/useTimeQueue";
import { loadTimeLookups } from "../lib/timeEntriesCloud";
import { loadClaims, mergeClaimsWithQueue, type FiledClaim } from "../lib/claimsCloud";
import {
  claimDates,
  claimRow,
  claimToday,
  CLAIM_CURRENCIES,
  validateClaim,
  withdrawnClaim,
  type ClaimDraft,
  type ClaimError,
} from "../lib/claimForm";
import { deleteReceipt, pickReceipt, type ReceiptFailure, type ReceiptSource } from "../lib/receiptPhoto";
import { sqliteUtc } from "../lib/timeEntryForm";
import { confirmAction } from "../lib/confirm";
import type { QueueItem } from "../lib/timeQueue";
import { colors, radius, space, type } from "../lib/theme";

/**
 * File an expense claim from the phone (plan step F6): what was bought, how
 * much, when, and a photo of the receipt. It is a CLAIM: the office accepts or
 * rejects it on the desktop, and only accepting creates an expense. Saved on
 * the phone first and sent through the outbox, photo before claim, so a dropped
 * signal never loses one and it never arrives twice.
 */

const LAST_PERSON_KEY = "namaa.claims.lastPerson";
const STATUS_TONE: Record<string, Tone> = { pending: "amber", accepted: "green", rejected: "red" };
const KNOWN_REFUSALS = new Set([
  "RECEIPT_TOO_LARGE",
  "RECEIPT_UPLOAD_REFUSED",
  "RECEIPT_FILE_MISSING",
  "CLAIM_NOT_OWN",
  "CLAIM_INVALID_DATE",
  "CLAIM_INVALID_RECEIPT",
  "CLAIM_PROJECT_UNAVAILABLE",
  "CLAIM_CATEGORY_UNAVAILABLE",
  "CLAIM_DECIDED_IMMUTABLE",
  "CLAIM_DECISION_FORBIDDEN",
  "CLAIM_IMMUTABLE_FIELD",
  "STALE",
  "42501",
]);
type ClaimQueueItem = Extract<QueueItem, { table: "expense_claims" }>;

function emptyDraft(personId: string | null, today: string): ClaimDraft {
  return { personId, projectId: null, date: today, amount: "", currency: "EGP", description: "", supplier: "", receipt: null };
}

export function ClaimsScreen() {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language as AppLocale) ?? "ar";
  const client = useSupabase();
  const queue = useTimeQueue();

  const [today, setToday] = useState(claimToday);
  useEffect(() => {
    const timer = setInterval(() => setToday(claimToday()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const lookups = useQuery({ queryKey: ["time-lookups"], queryFn: () => loadTimeLookups(client), staleTime: 5 * 60_000 });
  const claims = useQuery({ queryKey: ["expense-claims"], queryFn: () => loadClaims(client), staleTime: 30_000 });

  const [draft, setDraft] = useState<ClaimDraft>(() => emptyDraft(null, today));
  // Made when the form opens, so the photo's file name is already the claim's.
  const [claimUuid, setClaimUuid] = useState(() => Crypto.randomUUID());
  const [errors, setErrors] = useState<ClaimError[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Cancelling the picker is not a problem to report, so it has no message (see pick below).
  const [photoProblem, setPhotoProblem] = useState<Exclude<ReceiptFailure, "cancelled"> | null>(null);

  useEffect(() => {
    void AsyncStorage.getItem(LAST_PERSON_KEY)
      .catch(() => null)
      .then((personId) => {
        if (personId) setDraft((current) => (current.personId ? current : { ...current, personId }));
      });
  }, []);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of [...(lookups.data?.people ?? []), ...(lookups.data?.projects ?? [])]) map.set(option.id, option.label);
    return map;
  }, [lookups.data]);
  const nameOf = (id: string | null) => (id ? names.get(id) ?? t("mobile.unknownName") : t("common.overhead"));

  const claimItems = queue.state.items.filter((item): item is ClaimQueueItem => item.table === "expense_claims");
  const outbox = [...claimItems].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).filter((item) => item.status !== "sent");
  const filed = mergeClaimsWithQueue(claims.data ?? [], queue.state.items);
  const dates = claimDates(today);

  const update = (patch: Partial<ClaimDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors([]);
    setNotice(null);
  };

  const dateLabel = (date: string) => {
    if (date === dates[0]) return t("mobile.today");
    if (date === dates[1]) return t("mobile.yesterday");
    return formatIsoDate(date, locale);
  };

  const takePhoto = async (source: ReceiptSource) => {
    setPhotoProblem(null);
    const picked = await pickReceipt(source, claimUuid);
    if (picked.ok) update({ receipt: picked.receipt });
    else if (picked.reason !== "cancelled") setPhotoProblem(picked.reason);
  };

  const removePhoto = () => {
    if (draft.receipt) deleteReceipt(draft.receipt.path);
    update({ receipt: null });
  };

  const reset = (personId: string | null) => {
    setDraft(emptyDraft(personId, today));
    setClaimUuid(Crypto.randomUUID());
    setErrors([]);
    setPhotoProblem(null);
  };

  const save = async () => {
    const found = validateClaim(draft, today);
    setErrors(found);
    if (found.length > 0) return;
    // The session is kept on the phone, so this works with no signal.
    const { data } = await client.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) {
      setNotice(t("mobile.claimNeedsLogin"));
      return;
    }
    const now = new Date();
    const row = claimRow(draft, { uuid: claimUuid, userId, createdAt: sqliteUtc(now), submittedAt: now.toISOString() });
    queue.claim(row, draft.receipt?.path);
    void AsyncStorage.setItem(LAST_PERSON_KEY, row.person_id).catch(() => undefined);
    reset(draft.personId);
    setNotice(t("mobile.claimSaved"));
  };

  const withdraw = (claim: FiledClaim) => {
    confirmAction(
      t("mobile.claimWithdraw"),
      t("mobile.claimWithdrawConfirm", { description: claim.description }),
      { yes: t("mobile.claimWithdraw"), no: t("common.cancel") },
      () => {
        // Not in the cloud yet: simply drop it. Already filed: withdraw it there.
        const waiting = claimItems.find((item) => item.row.uuid === claim.uuid && item.status !== "sent");
        if (waiting && claim.queued) queue.discard(claim.uuid);
        else queue.claim(withdrawnClaim(claim.row, new Date()));
      },
      "destructive",
    );
  };

  const refusal = (reason: string | undefined) =>
    reason && KNOWN_REFUSALS.has(reason) ? t(`mobile.claimRefusal.${reason}`) : t("mobile.claimRefusal.other", { reason: reason ?? "?" });

  const money = (minor: number, currency: string) => formatMinor(minor, currency, locale);

  return (
    <View style={styles.page}>
      <ScreenHeader title={t("mobile.claimsTitle")} />
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={claims.isRefetching}
            onRefresh={() => {
              queue.sendNow();
              void claims.refetch();
              void lookups.refetch();
            }}
            tintColor={colors.brand}
          />
        }
      >
        {outbox.length > 0 ? (
          <>
            <SectionHeader title={t("mobile.outbox")} aside={queue.sending ? t("mobile.sending") : undefined} />
            <Card style={styles.outbox}>
              {outbox.map((item) => (
                <View key={item.row.uuid} style={styles.outboxRow}>
                  <View style={styles.outboxTop}>
                    <View style={styles.flex}>
                      <Text style={styles.entryTitle} numberOfLines={1}>
                        {item.row.deleted_at ? `${t("mobile.claimWithdraw")} · ` : ""}{item.row.description}
                      </Text>
                      <Text style={styles.entryLine} numberOfLines={1}>{money(item.row.amount_minor, item.row.currency)}</Text>
                    </View>
                    <Badge label={t(`mobile.status${item.status[0]!.toUpperCase()}${item.status.slice(1)}`)} tone={item.status === "rejected" ? "red" : "amber"} />
                  </View>
                  {item.status === "rejected" ? (
                    <>
                      <Text style={styles.error}>{refusal(item.lastError)}</Text>
                      <View style={styles.row}>
                        <Pressable onPress={() => queue.retry(item.row.uuid)} accessibilityRole="button" style={styles.secondary}>
                          <Icon name="refresh-cw" size={14} color={colors.brand} />
                          <Text style={styles.secondaryText}>{t("mobile.retry")}</Text>
                        </Pressable>
                        <Pressable onPress={() => queue.discard(item.row.uuid)} accessibilityRole="button" style={styles.secondary}>
                          <Icon name="x" size={14} color={colors.subtle} />
                          <Text style={[styles.secondaryText, styles.muted]}>{t("mobile.discard")}</Text>
                        </Pressable>
                      </View>
                    </>
                  ) : item.lastError ? (
                    <Text style={styles.entryLine}>{t("mobile.notSentYet", { reason: t("mobile.offline") })}</Text>
                  ) : null}
                </View>
              ))}
            </Card>
          </>
        ) : null}

        <SectionHeader title={t("mobile.newClaim")} />
        <Card style={styles.form}>
          <PickerField
            label={t("mobile.claimant")}
            value={draft.personId}
            options={lookups.data?.people ?? []}
            onChange={(personId) => update({ personId })}
            placeholder={t("mobile.choose")}
            invalid={errors.includes("person")}
          />
          <PickerField
            label={t("expenses.project")}
            value={draft.projectId}
            options={lookups.data?.projects ?? []}
            onChange={(projectId) => {
              const currency = lookups.data?.projects.find((p) => p.id === projectId)?.currency;
              update({
                projectId,
                ...(currency && (CLAIM_CURRENCIES as readonly string[]).includes(currency) ? { currency } : {}),
              });
            }}
            placeholder={t("common.overhead")}
            allowNone={t("common.overhead")}
          />

          <View style={styles.field}>
            <Text style={styles.label}>{t("common.description")}</Text>
            <TextInput
              value={draft.description}
              onChangeText={(description) => update({ description })}
              style={[styles.input, errors.includes("description") && styles.inputInvalid]}
              accessibilityLabel={t("common.description")}
            />
            {errors.includes("description") ? <Text style={styles.error}>{t("mobile.errClaimDescription")}</Text> : null}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("expenses.supplier")}</Text>
            <TextInput value={draft.supplier} onChangeText={(supplier) => update({ supplier })} style={styles.input} accessibilityLabel={t("expenses.supplier")} />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("mobile.amountLabel", { currency: draft.currency })}</Text>
            <TextInput
              value={draft.amount}
              onChangeText={(amount) => update({ amount })}
              placeholder={t("mobile.amountPlaceholder")}
              placeholderTextColor={colors.faint}
              keyboardType="decimal-pad"
              style={[styles.input, errors.includes("amount") && styles.inputInvalid]}
              accessibilityLabel={t("mobile.amountLabel", { currency: draft.currency })}
            />
            <View style={styles.chips}>
              {CLAIM_CURRENCIES.map((code) => (
                <Chip key={code} label={code} active={draft.currency === code} onPress={() => update({ currency: code })} />
              ))}
            </View>
            {errors.includes("amount") ? <Text style={styles.error}>{t("mobile.errAmount")}</Text> : null}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("common.date")}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {dates.map((date) => (
                <Chip key={date} label={dateLabel(date)} active={draft.date === date} onPress={() => update({ date })} />
              ))}
            </ScrollView>
            {errors.includes("date") ? <Text style={styles.error}>{t("mobile.errClaimDate")}</Text> : null}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("mobile.receiptPhoto")}</Text>
            {draft.receipt ? (
              <View style={styles.photoRow}>
                <Image source={{ uri: draft.receipt.path }} style={styles.thumb} accessibilityLabel={t("mobile.receiptPhoto")} />
                <View style={styles.flex}>
                  <Text style={styles.entryLine}>{Math.max(1, Math.round(draft.receipt.sizeBytes / 1024))} KB</Text>
                  <Pressable onPress={removePhoto} accessibilityRole="button" style={styles.secondary}>
                    <Icon name="trash-2" size={14} color={colors.red} />
                    <Text style={[styles.secondaryText, styles.dangerText]}>{t("mobile.removePhoto")}</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.row}>
                <Pressable onPress={() => void takePhoto("camera")} accessibilityRole="button" style={styles.secondary}>
                  <Icon name="camera" size={16} color={colors.brand} />
                  <Text style={styles.secondaryText}>{t("mobile.takePhoto")}</Text>
                </Pressable>
                <Pressable onPress={() => void takePhoto("library")} accessibilityRole="button" style={styles.secondary}>
                  <Icon name="image" size={16} color={colors.brand} />
                  <Text style={styles.secondaryText}>{t("mobile.choosePhoto")}</Text>
                </Pressable>
              </View>
            )}
            {errors.includes("receipt") ? <Text style={styles.error}>{t("mobile.errReceiptSize")}</Text> : null}
            {photoProblem ? <Text style={styles.error}>{t(`mobile.photoProblem.${photoProblem}`)}</Text> : null}
            <Text style={styles.hint}>{t("mobile.receiptOptional")}</Text>
          </View>

          {errors.includes("person") ? <Text style={styles.error}>{t("mobile.errPerson")}</Text> : null}

          <Pressable
            onPress={() => void save()}
            disabled={!queue.loaded}
            accessibilityRole="button"
            style={({ pressed }) => [styles.primary, (pressed || !queue.loaded) && styles.pressed]}
          >
            <Icon name="send" size={18} color={colors.onBrand} />
            <Text style={styles.primaryText}>{t("mobile.fileClaim")}</Text>
          </Pressable>
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          <Text style={styles.hint}>{t("mobile.claimHint")}</Text>
        </Card>

        <SectionHeader title={t("mobile.yourClaims")} />
        {filed.length === 0 ? (
          <Empty icon="file-text" text={claims.isLoading ? t("common.loading") : t("mobile.noClaims")} />
        ) : (
          filed.map((claim) => (
            <Card key={claim.uuid} style={styles.entry}>
              <IconBadge name={claim.hasReceipt ? "image" : "file-text"} tone={claim.status === "rejected" ? "red" : claim.status === "accepted" ? "green" : "brand"} />
              <View style={styles.flex}>
                <Text style={styles.entryTitle} numberOfLines={1}>{claim.description}</Text>
                <Text style={styles.entryLine} numberOfLines={1}>
                  {[money(claim.amountMinor, claim.currency), nameOf(claim.personId), dateLabel(claim.date), nameOf(claim.projectId)].join(" · ")}
                </Text>
                {claim.status === "rejected" && claim.decisionReason ? (
                  <Text style={styles.error} numberOfLines={3}>{t("mobile.claimReasonLabel")}: {claim.decisionReason}</Text>
                ) : null}
                {claim.status === "pending" ? (
                  <Pressable onPress={() => withdraw(claim)} accessibilityRole="button" style={styles.linkButton}>
                    <Icon name="corner-up-left" size={14} color={colors.red} />
                    <Text style={[styles.secondaryText, styles.dangerText]}>{t("mobile.claimWithdraw")}</Text>
                  </Pressable>
                ) : null}
              </View>
              <Badge
                label={claim.queued ? t("mobile.statusPending") : t(`mobile.claimStatus.${claim.status}`)}
                tone={claim.queued ? "amber" : STATUS_TONE[claim.status] ?? "neutral"}
              />
            </Card>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1, gap: 2 },
  container: { padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 },
  outbox: { gap: space.md },
  outboxRow: { gap: space.sm, paddingBottom: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  outboxTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  form: { gap: space.lg },
  field: { gap: 6 },
  label: { ...type.label, color: colors.subtle },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  row: { flexDirection: "row", gap: space.sm },
  input: { minHeight: 48, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, fontSize: 16, color: colors.text },
  inputInvalid: { borderColor: colors.red },
  photoRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  thumb: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: colors.chipBg },
  error: { ...type.label, color: colors.red },
  primary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, height: 50, borderRadius: radius.md, backgroundColor: colors.brand },
  pressed: { opacity: 0.8 },
  primaryText: { fontSize: 16, fontWeight: "700", color: colors.onBrand },
  secondary: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 42, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  secondaryText: { fontSize: 14, fontWeight: "600", color: colors.brand },
  muted: { color: colors.subtle },
  dangerText: { color: colors.red },
  linkButton: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingVertical: 4 },
  notice: { ...type.label, color: colors.green, textAlign: "center" },
  hint: { ...type.caption, color: colors.faint },
  entry: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  entryTitle: { ...type.heading, color: colors.text },
  entryLine: { ...type.caption, color: colors.subtle },
});
