import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TimeEntry, TimeEntryInput } from "@mep/core";
import { execute, select } from "../lib/db";

interface TimeRow {
  id: number;
  person_id: number;
  project_id: number;
  stage_id: number | null;
  date: string;
  minutes: number;
  billable: number;
  note: string | null;
  created_at: string;
  person_name?: string;
  person_currency?: string;
  hourly_rate_minor?: number | null;
  project_name?: string;
  project_code?: string;
  project_currency?: string;
  project_fx_rate_micro?: number;
  stage_name?: string | null;
}

export interface TimeEntryListItem extends TimeEntry {
  personName: string;
  personCurrency: string;
  hourlyRateMinor: number | null;
  projectName: string;
  projectCode: string;
  projectCurrency: string;
  projectFxRateMicro: number;
  stageName: string | null;
}

function mapEntry(r: TimeRow): TimeEntryListItem {
  return {
    id: r.id,
    personId: r.person_id,
    projectId: r.project_id,
    stageId: r.stage_id,
    date: r.date,
    minutes: r.minutes,
    billable: r.billable === 1,
    note: r.note,
    createdAt: r.created_at,
    personName: r.person_name ?? "",
    personCurrency: r.person_currency ?? "EGP",
    hourlyRateMinor: r.hourly_rate_minor ?? null,
    projectName: r.project_name ?? "",
    projectCode: r.project_code ?? "",
    projectCurrency: r.project_currency ?? "EGP",
    projectFxRateMicro: r.project_fx_rate_micro ?? 1_000_000,
    stageName: r.stage_name ?? null,
  };
}

const LIST_SQL = `
  SELECT te.*, pe.name AS person_name, pe.currency AS person_currency, pe.hourly_rate_minor AS hourly_rate_minor,
         p.name AS project_name, p.code AS project_code, p.currency AS project_currency,
         p.fx_rate_micro AS project_fx_rate_micro, s.name AS stage_name
  FROM time_entries te
  JOIN people pe ON pe.id = te.person_id
  JOIN projects p ON p.id = te.project_id
  LEFT JOIN project_stages s ON s.id = te.stage_id`;

export async function listTimeEntries(): Promise<TimeEntryListItem[]> {
  const rows = await select<TimeRow>(`${LIST_SQL} ORDER BY te.date DESC, te.id DESC`);
  return rows.map(mapEntry);
}

export async function listTimeEntriesByProject(projectId: number): Promise<TimeEntryListItem[]> {
  const rows = await select<TimeRow>(`${LIST_SQL} WHERE te.project_id = $1 ORDER BY te.date DESC, te.id DESC`, [projectId]);
  return rows.map(mapEntry);
}

export async function createTimeEntry(input: TimeEntryInput): Promise<number> {
  const r = await execute(
    `INSERT INTO time_entries (person_id, project_id, stage_id, date, minutes, billable, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.personId, input.projectId, input.stageId ?? null, input.date, input.minutes, input.billable ? 1 : 0, input.note ?? null],
  );
  return r.lastInsertId ?? 0;
}

export async function updateTimeEntry(id: number, input: TimeEntryInput): Promise<void> {
  await execute(
    `UPDATE time_entries SET person_id=$1, project_id=$2, stage_id=$3, date=$4, minutes=$5, billable=$6, note=$7
     WHERE id=$8`,
    [input.personId, input.projectId, input.stageId ?? null, input.date, input.minutes, input.billable ? 1 : 0, input.note ?? null, id],
  );
}

export async function deleteTimeEntry(id: number): Promise<void> {
  await execute("DELETE FROM time_entries WHERE id = $1", [id]);
}

export function useTimeEntries() {
  return useQuery({ queryKey: ["time-entries"], queryFn: listTimeEntries });
}
export function useTimeEntriesByProject(projectId: number) {
  return useQuery({ queryKey: ["time-entries", "project", projectId], queryFn: () => listTimeEntriesByProject(projectId) });
}

export function useTimeEntryMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["time-entries"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
  };
  return {
    create: useMutation({ mutationFn: createTimeEntry, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: (v: { id: number; input: TimeEntryInput }) => updateTimeEntry(v.id, v.input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteTimeEntry, onSuccess: invalidate }),
  };
}
