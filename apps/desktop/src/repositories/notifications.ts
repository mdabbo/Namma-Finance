import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isBillable } from "@mep/core";
import { useWorkspaceFinancials } from "./financials";
import { useRecurring } from "./recurring";
import { execute, selectOne } from "../lib/db";
import { todayIso, useFormat } from "../lib/format";

/**
 * Phase 5 notification center. Everything is DERIVED from the workspace
 * state — nothing is stored except the set of already-toasted keys, so
 * Windows popups fire once per new event while the in-app bell always
 * shows the full current picture.
 */

export type NotificationKind =
  | "OVERDUE" // billable certificate past due with money outstanding
  | "DUE_SOON" // certificate due within 7 days, unpaid
  | "READY_TO_COLLECT" // achieved milestones not certified yet
  | "TEAM_PAYABLE" // client paid — pay the team member
  | "BOND_EXPIRY" // performance bond expiring within 30 days
  | "RECURRING_DUE"; // recurring expense hits within 7 days

export interface NotificationItem {
  key: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  /** In-app route the item navigates to. */
  to: string;
}

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function useNotifications(): NotificationItem[] {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: ws } = useWorkspaceFinancials();
  const { data: recurring = [] } = useRecurring();

  return useMemo(() => {
    if (!ws) return [];
    const items: NotificationItem[] = [];
    const today = todayIso();
    const soon = addDays(today, 7);
    const bondHorizon = addDays(today, 30);

    const projectOf = (projectId: number) => ws.projects.find((p) => p.project.id === projectId)?.project;

    for (const state of ws.contractStates.values()) {
      const project = projectOf(state.contract.projectId);
      if (!project) continue;
      for (const cs of state.certificates) {
        if (!isBillable(cs.certificate.status) || cs.unpaidMinor <= 0 || !cs.dueDate) continue;
        if (cs.overdue) {
          items.push({
            key: `overdue-${cs.certificate.id}`,
            kind: "OVERDUE",
            title: `${cs.certificate.number} — ${project.name}`,
            detail: `${t("certificates.overdue")} · ${fmt.money(cs.unpaidMinor, project.currency, { compactFraction: true })}`,
            to: "/certificates",
          });
        } else if (cs.dueDate <= soon) {
          items.push({
            key: `due-${cs.certificate.id}-${cs.dueDate}`,
            kind: "DUE_SOON",
            title: `${cs.certificate.number} — ${project.name}`,
            detail: `${t("notifications.dueOn", { date: fmt.date(cs.dueDate) })} · ${fmt.money(cs.unpaidMinor, project.currency, { compactFraction: true })}`,
            to: "/certificates",
          });
        }
      }
      const bond = state.contract.performanceBondExpiry;
      if (bond && bond <= bondHorizon) {
        items.push({
          key: `bond-${state.contract.id}-${bond}`,
          kind: "BOND_EXPIRY",
          title: `${state.contract.number} — ${project.name}`,
          detail: t("notifications.bondExpires", { date: fmt.date(bond) }),
          to: `/projects/${project.id}`,
        });
      }
    }

    for (const item of ws.readyToCollect) {
      items.push({
        key: `rtc-${item.contractId}`,
        kind: "READY_TO_COLLECT",
        title: `${item.projectName} (${item.projectCode})`,
        detail: `${item.achievedTitles.join(" · ")} · ${fmt.money(item.readyMinor, item.currency, { compactFraction: true })}`,
        to: `/projects/${item.projectId}`,
      });
    }

    for (const item of ws.teamPayables) {
      items.push({
        key: `tp-${item.assignmentId}`,
        kind: "TEAM_PAYABLE",
        title: item.personName,
        detail: `${item.projectCode} · ${item.dueTitles.join(" · ")} · ${fmt.money(item.dueMinor, item.currency, { compactFraction: true })}`,
        to: `/people/${item.personId}`,
      });
    }

    const dayOfMonth = Number(today.slice(8, 10));
    const daysInMonth = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
    for (const rec of recurring) {
      if (!rec.isActive) continue;
      const due = Math.min(rec.dayOfMonth, daysInMonth);
      const delta = due - dayOfMonth;
      if (delta >= 0 && delta <= 7) {
        items.push({
          key: `rec-${rec.id}-${today.slice(0, 7)}`,
          kind: "RECURRING_DUE",
          title: rec.name,
          detail: `${t("notifications.dueOn", { date: fmt.date(`${today.slice(0, 7)}-${String(due).padStart(2, "0")}`) })} · ${fmt.money(rec.amountMinor, rec.currency, { compactFraction: true })}`,
          to: "/expenses",
        });
      }
    }

    return items;
  }, [ws, recurring, t, fmt]);
}

// ─── Windows toasts for newly appeared items ────────────────────────────────

const SEEN_KEY = "notified_keys";
const SEEN_CAP = 400;

async function loadSeen(): Promise<Set<string>> {
  const row = await selectOne<{ value: string }>("SELECT value FROM settings WHERE key = $1", [SEEN_KEY]);
  try {
    return new Set(row ? (JSON.parse(row.value) as string[]) : []);
  } catch {
    return new Set();
  }
}

async function saveSeen(seen: Set<string>): Promise<void> {
  const trimmed = [...seen].slice(-SEEN_CAP);
  await execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
    [SEEN_KEY, JSON.stringify(trimmed)],
  );
}

/** Toast each notification once when it first appears. Mounted in Layout. */
export function useNotificationToasts(items: NotificationItem[]): void {
  const { t } = useTranslation();
  const busy = useRef(false);
  const qc = useQueryClient();
  void qc; // (kept for future badge invalidation)

  useEffect(() => {
    if (items.length === 0 || busy.current) return;
    busy.current = true;
    void (async () => {
      try {
        const seen = await loadSeen();
        const fresh = items.filter((i) => !seen.has(i.key));
        if (fresh.length === 0) return;

        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) {
          // one toast per kind at most, so a big sync doesn't spam the desktop
          const byKind = new Map<NotificationKind, NotificationItem[]>();
          for (const item of fresh) {
            byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
          }
          for (const [kind, list] of byKind) {
            const first = list[0]!;
            sendNotification({
              title: t(`notifications.kind.${kind}`),
              body: list.length === 1 ? `${first.title} — ${first.detail}` : `${first.title} (+${list.length - 1})`,
            });
          }
        }
        for (const item of fresh) seen.add(item.key);
        await saveSeen(seen);
      } catch (err) {
        console.error("notification toasts failed", err);
      } finally {
        busy.current = false;
      }
    })();
  }, [items, t]);
}
