import { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { Text, TextInput } from "../components/AppText";
import { ScreenHeader } from "../components/ScreenHeader";
import { PickerField } from "../components/PickerField";
import { Badge, Card, Chip, Empty, Icon, IconBadge, SectionHeader, type Tone } from "../components/ui";
import { useSupabase } from "../hooks/useWorkspace";
import { useTimeQueue } from "../hooks/useTimeQueue";
import { loadRecentEntries, loadTimeLookups, mergeWithQueue, type Option } from "../lib/timeEntriesCloud";
import {
  formatHours,
  isDateOpen,
  localIsoDate,
  openDates,
  rowFromDraft,
  sqliteUtc,
  validateDraft,
  withdrawn,
  type DraftError,
  type TimeEntryDraft,
} from "../lib/timeEntryForm";
import type { QueueItem, QueueStatus, TimeEntryRow } from "../lib/timeQueue";
import { colors, radius, space, type } from "../lib/theme";

/**
 * Log time from the phone (plan step F5). An entry is saved on the phone
 * first and sent by the outbox (hooks/useTimeQueue), so it is never lost to a
 * dropped signal and never arrives twice. Only time entries are written; every
 * financial record stays on the desktop.
 */

const LAST_PERSON_KEY = "namaa.time.lastPerson";
const QUICK_HOURS = [1, 2, 4, 8];
const KNOWN_REFUSALS = new Set([
  "STALE",
  "TIME_ENTRY_LOCKED",
  "TIME_ENTRY_NOT_OWN",
  "TIME_ENTRY_PROJECT_UNAVAILABLE",
  "TIME_ENTRY_STAGE_MISMATCH",
  "TIME_ENTRY_INVALID_MINUTES",
  "TIME_ENTRY_INVALID_DATE",
  "TIME_ENTRY_IMMUTABLE_FIELD",
  "42501",
]);

const STATUS_TONE: Record<QueueStatus, Tone> = { pending: "amber", sent: "green", rejected: "red" };

function emptyDraft(today: string, personId: string | null): TimeEntryDraft {
  return { personId, projectId: null, stageId: null, date: today, hours: "", billable: true, note: "" };
}

function draftFromRow(row: TimeEntryRow): TimeEntryDraft {
  return {
    personId: row.person_id,
    projectId: row.project_id,
    stageId: row.stage_id,
    date: row.date,
    hours: formatHours(row.minutes),
    billable: row.billable === 1,
    note: row.note ?? "",
  };
}

/** Asks before deleting; on the web preview, Alert has no buttons. */
function confirmDelete(title: string, message: string, yes: string, no: string, onYes: () => void) {
  if (Platform.OS === "web") {
    if (globalThis.confirm?.(message)) onYes();
    return;
  }
  Alert.alert(title, message, [
    { text: no, style: "cancel" },
    { text: yes, style: "destructive", onPress: onYes },
  ]);
}

export function TimeScreen() {
  const { t, i18n } = useTranslation();
  const client = useSupabase();
  const queue = useTimeQueue();

  // Today moves on if the app stays open past midnight.
  const [today, setToday] = useState(() => localIsoDate(new Date()));
  useEffect(() => {
    const timer = setInterval(() => setToday(localIsoDate(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);

  const lookups = useQuery({ queryKey: ["time-lookups"], queryFn: () => loadTimeLookups(client), staleTime: 5 * 60_000 });
  const recent = useQuery({ queryKey: ["time-entries", today], queryFn: () => loadRecentEntries(client, today), staleTime: 30_000 });

  const [draft, setDraft] = useState<TimeEntryDraft>(() => emptyDraft(today, null));
  const [editing, setEditing] = useState<TimeEntryRow | null>(null);
  const [errors, setErrors] = useState<DraftError[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // Start with the person used last time.
  useEffect(() => {
    void AsyncStorage.getItem(LAST_PERSON_KEY)
      .catch(() => null)
      .then((personId) => {
        if (personId) setDraft((current) => (current.personId ? current : { ...current, personId }));
      });
  }, []);

  const names = useMemo(() => {
    const map = new Map<string, Option>();
    for (const option of [...(lookups.data?.people ?? []), ...(lookups.data?.projects ?? [])]) map.set(option.id, option);
    for (const stages of lookups.data?.stages.values() ?? []) for (const stage of stages) map.set(stage.id, stage);
    return map;
  }, [lookups.data]);
  const nameOf = (id: string | null) => (id ? names.get(id)?.label ?? t("mobile.unknownName") : "");

  const stages = draft.projectId ? lookups.data?.stages.get(draft.projectId) ?? [] : [];
  const dates = openDates(today);
  const entries = mergeWithQueue(recent.data ?? [], queue.state.items);
  const outbox = [...queue.state.items].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  const waiting = outbox.some((item) => item.status === "pending");

  const update = (patch: Partial<TimeEntryDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors([]);
    setNotice(null);
  };

  const reset = () => {
    setEditing(null);
    setErrors([]);
    setDraft((current) => emptyDraft(today, current.personId));
  };

  const save = () => {
    const found = validateDraft(draft, today);
    setErrors(found);
    if (found.length > 0) return;
    const row = rowFromDraft(draft, {
      uuid: editing?.uuid ?? Crypto.randomUUID(),
      createdAt: editing?.created_at ?? sqliteUtc(new Date()),
    });
    queue.save(row);
    void AsyncStorage.setItem(LAST_PERSON_KEY, row.person_id).catch(() => undefined);
    reset();
    setNotice(t("mobile.savedQueued"));
  };

  const remove = () => {
    if (!editing) return;
    const row = editing;
    confirmDelete(t("mobile.deleteEntry"), t("mobile.deleteEntryConfirm"), t("common.delete"), t("common.cancel"), () => {
      queue.save(withdrawn(row, new Date()));
      reset();
    });
  };

  const refusal = (reason: string | undefined) =>
    reason && KNOWN_REFUSALS.has(reason) ? t(`mobile.refusal.${reason}`) : t("mobile.refusal.other", { reason: reason ?? "?" });

  const dateLabel = (date: string) => {
    if (date === dates[0]) return t("mobile.today");
    if (date === dates[1]) return t("mobile.yesterday");
    try {
      return new Date(`${date}T12:00:00`).toLocaleDateString(i18n.language, { weekday: "short", day: "numeric", month: "short" });
    } catch {
      return date.slice(5);
    }
  };

  const entryLine = (row: TimeEntryRow) =>
    [nameOf(row.person_id), dateLabel(row.date), `${formatHours(row.minutes)} ${t("time.hoursShort")}`].filter(Boolean).join(" · ");

  return (
    <View style={styles.page}>
      <ScreenHeader title={t("nav.time")} />
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={recent.isRefetching}
            onRefresh={() => {
              queue.sendNow();
              void recent.refetch();
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
                <OutboxRow
                  key={item.row.uuid}
                  item={item}
                  title={item.row.deleted_at ? `${t("mobile.deleteEntry")} · ${nameOf(item.row.project_id)}` : nameOf(item.row.project_id)}
                  line={entryLine(item.row)}
                  statusLabel={t(`mobile.status${item.status[0]!.toUpperCase()}${item.status.slice(1)}`)}
                  reason={
                    item.status === "rejected"
                      ? refusal(item.lastError)
                      : item.status === "pending" && item.lastError
                        ? t("mobile.notSentYet", { reason: t("mobile.offline") })
                        : null
                  }
                  onRetry={() => queue.retry(item.row.uuid)}
                  onDiscard={() => queue.discard(item.row.uuid)}
                  retryLabel={t("mobile.retry")}
                  discardLabel={t("mobile.discard")}
                />
              ))}
              {waiting && !queue.sending ? (
                <Pressable onPress={queue.sendNow} accessibilityRole="button" style={styles.linkButton}>
                  <Icon name="upload-cloud" size={16} color={colors.brand} />
                  <Text style={styles.linkText}>{t("mobile.sendNow")}</Text>
                </Pressable>
              ) : null}
            </Card>
          </>
        ) : null}

        <SectionHeader title={editing ? t("mobile.editEntry") : t("time.newEntry")} />
        <Card style={styles.form}>
          <PickerField
            label={t("time.person")}
            value={draft.personId}
            options={lookups.data?.people ?? []}
            onChange={(personId) => update({ personId })}
            placeholder={t("mobile.choose")}
            invalid={errors.includes("person")}
          />
          <PickerField
            label={t("projects.single")}
            value={draft.projectId}
            options={lookups.data?.projects ?? []}
            onChange={(projectId) => update({ projectId, stageId: null })}
            placeholder={t("mobile.choose")}
            invalid={errors.includes("project")}
          />
          {stages.length > 0 ? (
            <PickerField
              label={t("time.stage")}
              value={draft.stageId}
              options={stages}
              onChange={(stageId) => update({ stageId })}
              placeholder={t("time.noStage")}
              allowNone={t("time.noStage")}
            />
          ) : null}

          <View style={styles.field}>
            <Text style={styles.label}>{t("common.date")}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {dates.map((date) => (
                <Chip key={date} label={dateLabel(date)} active={draft.date === date} onPress={() => update({ date })} />
              ))}
            </ScrollView>
            {errors.includes("date") ? <Text style={styles.error}>{t("mobile.errDate")}</Text> : null}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("time.hours")}</Text>
            <TextInput
              value={draft.hours}
              onChangeText={(hours) => update({ hours })}
              placeholder={t("mobile.hoursPlaceholder")}
              placeholderTextColor={colors.faint}
              keyboardType="decimal-pad"
              style={[styles.input, errors.includes("hours") && styles.inputInvalid]}
              accessibilityLabel={t("time.hours")}
            />
            <View style={styles.chips}>
              {QUICK_HOURS.map((hours) => (
                <Chip
                  key={hours}
                  label={t("mobile.quickHours", { count: hours })}
                  active={draft.hours === String(hours)}
                  onPress={() => update({ hours: String(hours) })}
                />
              ))}
            </View>
            {errors.includes("hours") ? <Text style={styles.error}>{t("mobile.errHours")}</Text> : null}
          </View>

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>{draft.billable ? t("time.billable") : t("time.nonBillable")}</Text>
            <Switch
              value={draft.billable}
              onValueChange={(billable) => update({ billable })}
              trackColor={{ true: colors.brand, false: colors.stone }}
              thumbColor={colors.card}
              accessibilityLabel={t("time.billable")}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("common.notes")}</Text>
            <TextInput
              value={draft.note}
              onChangeText={(note) => update({ note })}
              multiline
              style={[styles.input, styles.note]}
              accessibilityLabel={t("common.notes")}
            />
          </View>

          {errors.includes("person") ? <Text style={styles.error}>{t("mobile.errPerson")}</Text> : null}
          {errors.includes("project") ? <Text style={styles.error}>{t("mobile.errProject")}</Text> : null}

          <Pressable
            onPress={save}
            disabled={!queue.loaded}
            accessibilityRole="button"
            style={({ pressed }) => [styles.primary, (pressed || !queue.loaded) && styles.primaryPressed]}
          >
            <Icon name="check" size={18} color={colors.onBrand} />
            <Text style={styles.primaryText}>{t("common.save")}</Text>
          </Pressable>
          {editing ? (
            <View style={styles.secondaryRow}>
              <Pressable onPress={reset} accessibilityRole="button" style={styles.secondary}>
                <Text style={styles.secondaryText}>{t("common.cancel")}</Text>
              </Pressable>
              <Pressable onPress={remove} accessibilityRole="button" style={[styles.secondary, styles.danger]}>
                <Icon name="trash-2" size={16} color={colors.red} />
                <Text style={[styles.secondaryText, styles.dangerText]}>{t("mobile.deleteEntry")}</Text>
              </Pressable>
            </View>
          ) : null}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          <Text style={styles.hint}>{t("mobile.timeHint")}</Text>
        </Card>

        <SectionHeader title={t("mobile.recentEntries")} />
        {entries.length === 0 ? (
          <Empty icon="clock" text={recent.isLoading ? t("common.loading") : t("mobile.noEntries")} />
        ) : (
          entries.map(({ row, queued }) => {
            const open = isDateOpen(row.date, today);
            return (
              <Card
                key={row.uuid}
                style={[styles.entry, editing?.uuid === row.uuid && styles.entryEditing]}
                onPress={open ? () => {
                  setEditing(row);
                  setDraft(draftFromRow(row));
                  setErrors([]);
                  setNotice(null);
                } : undefined}
              >
                <IconBadge name="clock" tone={row.billable ? "brand" : "neutral"} />
                <View style={styles.entryText}>
                  <Text style={styles.entryTitle} numberOfLines={1}>{nameOf(row.project_id)}</Text>
                  <Text style={styles.entryLine} numberOfLines={1}>{entryLine(row)}</Text>
                  {row.stage_id ? <Text style={styles.entryLine} numberOfLines={1}>{nameOf(row.stage_id)}</Text> : null}
                  {row.note ? <Text style={styles.entryNote} numberOfLines={2}>{row.note}</Text> : null}
                </View>
                {queued ? <Badge label={t("mobile.statusPending")} tone="amber" /> : null}
              </Card>
            );
          })
        )}
        <Text style={styles.footnote}>{t("mobile.lockedHint")}</Text>
      </ScrollView>
    </View>
  );
}

function OutboxRow({
  item,
  title,
  line,
  statusLabel,
  reason,
  onRetry,
  onDiscard,
  retryLabel,
  discardLabel,
}: {
  item: QueueItem;
  title: string;
  line: string;
  statusLabel: string;
  reason: string | null;
  onRetry: () => void;
  onDiscard: () => void;
  retryLabel: string;
  discardLabel: string;
}) {
  return (
    <View style={styles.outboxRow}>
      <View style={styles.outboxTop}>
        <View style={styles.entryText}>
          <Text style={styles.entryTitle} numberOfLines={1}>{title}</Text>
          <Text style={styles.entryLine} numberOfLines={1}>{line}</Text>
        </View>
        <Badge label={statusLabel} tone={STATUS_TONE[item.status]} />
      </View>
      {reason ? <Text style={item.status === "rejected" ? styles.error : styles.entryLine}>{reason}</Text> : null}
      {item.status === "rejected" ? (
        <View style={styles.secondaryRow}>
          <Pressable onPress={onRetry} accessibilityRole="button" style={styles.secondary}>
            <Icon name="refresh-cw" size={14} color={colors.brand} />
            <Text style={styles.secondaryText}>{retryLabel}</Text>
          </Pressable>
          <Pressable onPress={onDiscard} accessibilityRole="button" style={styles.secondary}>
            <Icon name="x" size={14} color={colors.subtle} />
            <Text style={[styles.secondaryText, styles.mutedText]}>{discardLabel}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  container: { padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 },
  outbox: { gap: space.md },
  outboxRow: { gap: space.sm, paddingBottom: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  outboxTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  form: { gap: space.lg },
  field: { gap: 6 },
  label: { ...type.label, color: colors.subtle },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  input: {
    minHeight: 48,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    fontSize: 16,
    color: colors.text,
  },
  inputInvalid: { borderColor: colors.red },
  note: { minHeight: 72, paddingTop: space.md, textAlignVertical: "top" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { ...type.body, color: colors.text, fontWeight: "600" },
  error: { ...type.label, color: colors.red },
  primary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, height: 50, borderRadius: radius.md, backgroundColor: colors.brand },
  primaryPressed: { opacity: 0.8 },
  primaryText: { fontSize: 16, fontWeight: "700", color: colors.onBrand },
  secondaryRow: { flexDirection: "row", gap: space.sm },
  secondary: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 42, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  secondaryText: { fontSize: 14, fontWeight: "600", color: colors.brand },
  mutedText: { color: colors.subtle },
  danger: { borderColor: colors.redTint, backgroundColor: colors.redTint },
  dangerText: { color: colors.red },
  linkButton: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  linkText: { fontSize: 14, fontWeight: "700", color: colors.brand },
  notice: { ...type.label, color: colors.green, textAlign: "center" },
  hint: { ...type.caption, color: colors.faint, textAlign: "center" },
  entry: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  entryEditing: { borderColor: colors.brand },
  entryText: { flex: 1, gap: 2 },
  entryTitle: { ...type.heading, color: colors.text },
  entryLine: { ...type.caption, color: colors.subtle },
  entryNote: { ...type.caption, color: colors.faint },
  footnote: { ...type.caption, color: colors.faint, textAlign: "center", marginTop: space.sm },
});
