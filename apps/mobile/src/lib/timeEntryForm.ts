import { timeEntrySchema } from "@mep/core";
import type { TimeEntryRow } from "./timeQueue";

/**
 * The rules of the phone's time-entry form, kept free of React Native so the
 * desktop test suite can hold them in place.
 *
 * The phone signs in with an office login, and the cloud lets office logins
 * write any time entry: the 14-day rule in `supabase-0021` only binds an
 * engineer's own login. So the phone applies the same window itself — an
 * entry from more than 14 days ago is the office's to change, on the desktop.
 */

/** How far back the phone may add or change an entry, in days. Same as 0021. */
export const OPEN_DAYS = 14;

const DAY_MS = 86_400_000;

/** A local calendar date as YYYY-MM-DD. */
export function localIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const utc = Date.UTC(y!, m! - 1, d!) + days * DAY_MS;
  return new Date(utc).toISOString().slice(0, 10);
}

/** The dates the form offers, newest first: today and the 14 days before it. */
export function openDates(today: string): string[] {
  return Array.from({ length: OPEN_DAYS + 1 }, (_, i) => addDays(today, -i));
}

/** Whether an entry dated `date` may still be added, changed or withdrawn. */
export function isDateOpen(date: string, today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= addDays(today, -OPEN_DAYS) && date <= today;
}

/** Arabic-Indic and Persian digits, and the Arabic decimal and thousands marks. */
function westernDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, ".")
    .replace(/٬/g, "");
}

/**
 * Hours as typed, in whole minutes: "1.5", "1,5", "١٫٥" and "1:30" are all 90.
 * Returns null for anything else, including zero and negative amounts.
 */
export function parseHours(text: string): number | null {
  const value = westernDigits(text.trim());
  let minutes: number;
  const clock = /^(\d{1,4}):([0-5]?\d)$/.exec(value);
  if (clock) {
    minutes = Number(clock[1]) * 60 + Number(clock[2]);
  } else if (/^\d{0,4}(\.\d{0,4})?$/.test(value) && /\d/.test(value)) {
    minutes = Math.round(Number(value) * 60);
  } else {
    return null;
  }
  return minutes > 0 ? minutes : null;
}

/** Minutes as the form shows them: "1.5", "8", "0.25". */
export function formatHours(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100);
}

export interface TimeEntryDraft {
  personId: string | null;
  projectId: string | null;
  stageId: string | null;
  date: string;
  hours: string;
  billable: boolean;
  note: string;
}

export type DraftError = "person" | "project" | "hours" | "date";

/**
 * Checks a draft with the same schema the desktop uses (`timeEntrySchema`),
 * plus the phone's 14-day window. Returns the fields that are wrong.
 */
export function validateDraft(draft: TimeEntryDraft, today: string): DraftError[] {
  const errors: DraftError[] = [];
  if (!draft.personId) errors.push("person");
  if (!draft.projectId) errors.push("project");
  const minutes = parseHours(draft.hours);
  // The core schema is written for the desktop's integer ids; the uuids are
  // checked above, so stand-ins are passed for them here.
  const parsed = timeEntrySchema.safeParse({
    personId: 1,
    projectId: 1,
    stageId: draft.stageId ? 1 : null,
    date: draft.date,
    minutes: minutes ?? 0,
    billable: draft.billable,
    note: draft.note.trim() || null,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "minutes" && !errors.includes("hours")) errors.push("hours");
      if (field === "date" && !errors.includes("date")) errors.push("date");
    }
  }
  if (minutes === null && !errors.includes("hours")) errors.push("hours");
  if (!isDateOpen(draft.date, today) && !errors.includes("date")) errors.push("date");
  return errors;
}

/** The desktop's spelling of "now" for created_at: UTC, "YYYY-MM-DD HH:MM:SS". */
export function sqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Turns a valid draft into the row the queue sends. `existing` is the entry
 * being changed, so its uuid and created_at are kept.
 */
export function rowFromDraft(
  draft: TimeEntryDraft,
  ids: { uuid: string; createdAt: string },
): TimeEntryRow {
  return {
    uuid: ids.uuid,
    person_id: draft.personId!,
    project_id: draft.projectId!,
    stage_id: draft.stageId,
    date: draft.date,
    minutes: parseHours(draft.hours)!,
    billable: draft.billable ? 1 : 0,
    note: draft.note.trim() || null,
    created_at: ids.createdAt,
    deleted_at: null,
  };
}

/** The same entry, withdrawn. */
export function withdrawn(row: TimeEntryRow, now: Date): TimeEntryRow {
  return { ...row, deleted_at: now.toISOString() };
}
