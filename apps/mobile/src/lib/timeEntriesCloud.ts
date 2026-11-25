import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyError, serverMsFromDateHeader, type SendOutcome, type TimeEntryRow } from "./timeQueue";
import { addDays, OPEN_DAYS } from "./timeEntryForm";

/**
 * The time-entry calls the phone makes to the cloud. This is the ONLY table
 * the phone writes (plan 11.2: "the phone captures; the desktop decides").
 */

export const TIME_ENTRIES = "time_entries";

/**
 * Sends one row. The uuid is the table's key, so a resend updates the same row.
 *
 * An empty answer with no error means the cloud's last-writer-wins guard
 * kept a newer version of this entry (changed on a desktop after this one was
 * stamped), so this change is refused rather than reported as sent.
 */
export async function sendTimeEntry(client: SupabaseClient, row: TimeEntryRow & { updated_at: string }): Promise<SendOutcome> {
  const { data, error, status } = await client.from(TIME_ENTRIES).upsert(row, { onConflict: "uuid" }).select("uuid");
  if (error) return classifyError({ code: error.code, message: error.message, status });
  if (!data || data.length === 0) return { kind: "rejected", message: "STALE" };
  return { kind: "ok" };
}

/** The cloud's clock, read from the `Date` header of its health check. */
export async function fetchServerNow(url: string, anonKey: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const response = await fetchImpl(`${url.replace(/\/+$/, "")}/auth/v1/health`, { headers: { apikey: anonKey } });
  const ms = serverMsFromDateHeader(response.headers.get("date"));
  if (ms === null) throw new Error("NO_SERVER_TIME");
  return ms;
}

export interface Option {
  id: string;
  label: string;
  hint?: string;
}

export interface TimeLookups {
  people: Option[];
  projects: Option[];
  /** Stages by project uuid. */
  stages: Map<string, Option[]>;
}

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

async function liveRows(client: SupabaseClient, table: string, columns: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .is("deleted_at", null)
      .order("uuid")
      .range(rows.length, rows.length + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) return rows;
  }
}

const byLabel = (a: Option, b: Option) => a.label.localeCompare(b.label);

/** People, live projects and their stages: what the form's pickers offer. */
export async function loadTimeLookups(client: SupabaseClient): Promise<TimeLookups> {
  const [people, projects, stages] = await Promise.all([
    liveRows(client, "people", "uuid,name,archived_at"),
    liveRows(client, "projects", "uuid,code,name,status,archived_at"),
    liveRows(client, "project_stages", "uuid,project_id,name,sort_order"),
  ]);
  const stageMap = new Map<string, Option[]>();
  const ordered = [...stages].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  for (const stage of ordered) {
    const list = stageMap.get(str(stage.project_id)) ?? [];
    list.push({ id: str(stage.uuid), label: str(stage.name) });
    stageMap.set(str(stage.project_id), list);
  }
  // Completed projects sort last; archived ones are not offered at all.
  const liveProjects = projects.filter((row) => row.archived_at == null);
  const open = liveProjects.filter((row) => row.status !== "COMPLETED");
  const done = liveProjects.filter((row) => row.status === "COMPLETED");
  const toOption = (row: Row): Option => ({ id: str(row.uuid), label: str(row.name), hint: str(row.code) || undefined });
  return {
    people: people.filter((row) => row.archived_at == null).map((row) => ({ id: str(row.uuid), label: str(row.name) })).sort(byLabel),
    projects: [...open.map(toOption).sort(byLabel), ...done.map(toOption).sort(byLabel)],
    stages: stageMap,
  };
}

/** Entries the phone may still change: dated in the open window, not withdrawn. */
export async function loadRecentEntries(client: SupabaseClient, today: string): Promise<TimeEntryRow[]> {
  const { data, error } = await client
    .from(TIME_ENTRIES)
    .select("uuid,person_id,project_id,stage_id,date,minutes,billable,note,created_at,deleted_at")
    .is("deleted_at", null)
    .gte("date", addDays(today, -OPEN_DAYS))
    .order("date", { ascending: false })
    .limit(200);
  if (error) throw new Error(`${TIME_ENTRIES}: ${error.message}`);
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    uuid: str(row.uuid),
    person_id: str(row.person_id),
    project_id: str(row.project_id),
    stage_id: typeof row.stage_id === "string" ? row.stage_id : null,
    date: str(row.date),
    minutes: Number(row.minutes) || 0,
    billable: Number(row.billable) === 0 ? 0 : 1,
    note: typeof row.note === "string" ? row.note : null,
    created_at: str(row.created_at),
    deleted_at: null,
  }));
}

/**
 * The list the screen shows: the cloud's entries with the phone's queued
 * versions laid over them (a queued change is what the user last saw), and
 * queued withdrawals taken out.
 */
export function mergeWithQueue(
  cloud: TimeEntryRow[],
  queued: { row: TimeEntryRow; status: string }[],
): { row: TimeEntryRow; queued: boolean }[] {
  const byUuid = new Map<string, { row: TimeEntryRow; queued: boolean }>();
  for (const row of cloud) byUuid.set(row.uuid, { row, queued: false });
  for (const item of queued) {
    if (item.status === "sent") {
      // Already in the cloud; the cloud's copy is shown once it is reloaded.
      if (!byUuid.has(item.row.uuid) && item.row.deleted_at == null) byUuid.set(item.row.uuid, { row: item.row, queued: false });
      if (item.row.deleted_at != null) byUuid.delete(item.row.uuid);
      continue;
    }
    if (item.row.deleted_at != null) byUuid.delete(item.row.uuid);
    else byUuid.set(item.row.uuid, { row: item.row, queued: true });
  }
  return [...byUuid.values()].sort(
    (a, b) => b.row.date.localeCompare(a.row.date) || b.row.created_at.localeCompare(a.row.created_at),
  );
}
