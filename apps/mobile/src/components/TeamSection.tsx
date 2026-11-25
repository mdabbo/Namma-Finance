import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatIsoDate, formatMinor, type AppLocale } from "@mep/core";
import { Text } from "./AppText";
import { Badge, Card, Empty, Icon, IconBadge, LegendDot, SectionHeader, SegmentBar, type Tone } from "./ui";
import { availableDue, queuedNotLoaded, type TeamMember } from "../lib/team";
import type { QueueItem, QueueStatus } from "../lib/timeQueue";
import { colors, radius, space, type } from "../lib/theme";

/**
 * A project's team: for each member what was agreed, earned, paid and when,
 * what is due now and what remains, and a Pay button while something is due.
 */

const STAGE_TONE: Record<string, Tone> = { PENDING: "neutral", AWAITING_COLLECTION: "blue", PAYABLE: "amber", PAID_OUT: "green" };
const QUEUE_TONE: Record<QueueStatus, Tone> = { pending: "amber", sent: "green", rejected: "red" };

export function TeamSection({
  members,
  queueItems,
  onPay,
}: {
  members: TeamMember[];
  queueItems: QueueItem[];
  onPay: (assignmentUuid: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SectionHeader title={t("projects.team")} aside={t("mobile.itemsCount", { count: members.length })} />
      {members.length === 0 ? (
        <Card><Empty icon="users" text={t("projects.emptyTeam")} /></Card>
      ) : (
        members.map((member) => <MemberCard key={member.assignmentUuid} member={member} queueItems={queueItems} onPay={onPay} />)
      )}
    </>
  );
}

function MemberCard({ member, queueItems, onPay }: { member: TeamMember; queueItems: QueueItem[]; onPay: (uuid: string) => void }) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language as AppLocale) ?? "ar";
  const [showSchedule, setShowSchedule] = useState(false);
  const money = (minor: number) => formatMinor(minor, member.currency, locale, { compactFraction: true });
  const canPayNow = availableDue(member, queueItems);
  const queued = queuedNotLoaded(queueItems, member);
  const statusOf = (uuid: string) => queueItems.find((item) => item.row.uuid === uuid)?.status ?? "pending";

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <IconBadge name="user" tone="brand" size={36} />
        <View style={styles.headText}>
          <Text style={styles.name} numberOfLines={1}>{member.personName}</Text>
          {member.lifecycle !== "ACTIVE" ? <Badge label={t(`assignments.lifecycle.${member.lifecycle}`)} tone={member.lifecycle === "CANCELLED" ? "red" : "green"} /> : null}
        </View>
        {member.payable && canPayNow > 0 ? (
          <Pressable
            onPress={() => onPay(member.assignmentUuid)}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.payTitle", { name: member.personName })}
            style={({ pressed }) => [styles.payButton, pressed && styles.pressed]}
          >
            <Icon name="send" size={15} color={colors.onBrand} />
            <Text style={styles.payText}>{t("team.payStage")}</Text>
          </Pressable>
        ) : null}
      </View>

      <SegmentBar
        total={member.agreedMinor}
        segments={[
          { value: member.paidMinor, color: colors.green },
          { value: member.dueMinor, color: colors.accent },
        ]}
      />
      <View style={styles.legend}>
        <LegendDot color={colors.green} label={t("people.paidToDate")} value={money(member.paidMinor)} />
        <LegendDot color={colors.accent} label={t("team.dueNow")} value={money(member.dueMinor)} />
      </View>

      <View style={styles.figures}>
        <Figure label={t("people.agreedAmount")} value={money(member.agreedMinor)} />
        <Figure label={member.lifecycle === "CANCELLED" ? t("assignments.earnedFrozen") : t("mobile.earned")} value={money(member.earnedMinor)} />
        <Figure label={t("people.remainingAmount")} value={money(member.remainingMinor)} />
      </View>

      {!member.payable ? <Text style={styles.note}>{t("mobile.archivedNoPay")}</Text> : member.dueMinor === 0 ? <Text style={styles.note}>{t("mobile.nothingDue")}</Text> : null}

      <Text style={styles.subTitle}>{t("people.payments")}</Text>
      {queued.length === 0 && member.payments.length === 0 ? <Text style={styles.note}>{t("mobile.noPayments")}</Text> : null}
      {queued.map((row) => {
        const status = statusOf(row.uuid);
        return (
          <View key={row.uuid} style={styles.payment}>
            <Text style={styles.paymentDate}>{formatIsoDate(row.date, locale)}</Text>
            <Text style={styles.paymentNote} numberOfLines={1}>{row.note ?? ""}</Text>
            <Badge label={t(`mobile.status${status[0]!.toUpperCase()}${status.slice(1)}`)} tone={QUEUE_TONE[status]} />
            <Text style={styles.paymentAmount}>{money(row.amount_minor)}</Text>
          </View>
        );
      })}
      {member.payments.map((payment) => (
        <View key={payment.uuid} style={styles.payment}>
          <Text style={[styles.paymentDate, payment.voided && styles.voided]}>{formatIsoDate(payment.date, locale)}</Text>
          <Text style={styles.paymentNote} numberOfLines={1}>{payment.note ?? ""}</Text>
          {payment.voided ? <Badge label={t("mobile.voided")} tone="red" /> : payment.kind === "SPECIAL" ? <Badge label={t("mobile.special")} tone="blue" /> : null}
          <Text style={[styles.paymentAmount, payment.voided && styles.voided]}>{money(payment.amountMinor)}</Text>
        </View>
      ))}

      {member.stages.length > 0 ? (
        <>
          <Pressable onPress={() => setShowSchedule((v) => !v)} accessibilityRole="button" style={styles.toggle}>
            <Icon name={showSchedule ? "chevron-up" : "chevron-down"} size={16} color={colors.brand} />
            <Text style={styles.toggleText}>{showSchedule ? t("mobile.hideSchedule") : t("mobile.showSchedule")}</Text>
          </Pressable>
          {showSchedule
            ? member.stages.map((stage, index) => (
                <View key={`${stage.contractNumber}-${index}`} style={styles.stage}>
                  <Text style={styles.stageTitle} numberOfLines={2}>{stage.kind === "REMAINDER" ? t("team.remainder") : stage.title}</Text>
                  <Badge label={t(`team.status.${stage.status}`)} tone={STAGE_TONE[stage.status] ?? "neutral"} />
                  <Text style={styles.paymentAmount}>{money(stage.amountMinor)}</Text>
                </View>
              ))
            : null}
        </>
      ) : null}
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.figure}>
      <Text style={styles.figureLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.figureValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  headText: { flex: 1, gap: 4 },
  name: { ...type.heading, color: colors.text },
  payButton: { flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.brand },
  pressed: { opacity: 0.85 },
  payText: { fontSize: 14, fontWeight: "700", color: colors.onBrand },
  legend: { flexDirection: "row", gap: space.md },
  figures: { flexDirection: "row", gap: space.sm },
  figure: { flex: 1, padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.chipBg, gap: 2 },
  figureLabel: { ...type.caption, color: colors.subtle },
  figureValue: { fontSize: 13, fontWeight: "700", color: colors.text },
  note: { ...type.caption, color: colors.subtle },
  subTitle: { ...type.label, color: colors.subtle, marginTop: space.xs },
  payment: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  paymentDate: { ...type.caption, color: colors.subtle, minWidth: 72 },
  paymentNote: { ...type.caption, color: colors.faint, flex: 1 },
  paymentAmount: { fontSize: 13, fontWeight: "700", color: colors.text },
  voided: { textDecorationLine: "line-through", color: colors.faint },
  toggle: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingVertical: 4 },
  toggleText: { fontSize: 13, fontWeight: "700", color: colors.brand },
  stage: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  stageTitle: { ...type.caption, color: colors.text, flex: 1 },
});
