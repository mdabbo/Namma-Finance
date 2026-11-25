/**
 * The phone's outbox for time entries (plan steps F4 and F5).
 *
 * Site signal is unreliable, so a time entry is never sent straight from the
 * form: it is put in this queue, kept on the phone, and sent when the cloud
 * answers. Four rules make that safe:
 *
 * 1. Exactly once. Each entry carries a uuid made on the phone, and the cloud
 *    table's primary key is that uuid, so sending it again (after a lost
 *    answer, or a retry) updates the same row instead of adding a second one.
 * 2. One queue item per entry. Changing an entry that is still waiting
 *    replaces the waiting copy; the queue never holds two versions of it.
 * 3. Cloud time, not phone time. Desktops pull rows "changed after" the last
 *    one they saw. A row stamped by a phone whose clock is slow would sort
 *    before that point and no desktop would ever pull it, so `updated_at` is
 *    taken from the cloud's clock (see `stampFor`).
 * 4. A refusal is not retried. A network failure leaves the item waiting; a
 *    refusal from the cloud (a rule, a permission) marks it rejected with the
 *    reason, and only the user can retry or discard it.
 *
 * Nothing in this file imports React Native, so it is tested from the desktop
 * test suite (apps/desktop/test/mobile-time-queue.test.ts).
 */

/** A time entry in the cloud's own column names, minus `updated_at`. */
export interface TimeEntryRow {
  uuid: string;
  person_id: string;
  project_id: string;
  stage_id: string | null;
  /** YYYY-MM-DD */
  date: string;
  minutes: number;
  billable: 0 | 1;
  note: string | null;
  /** "YYYY-MM-DD HH:MM:SS" in UTC, the desktop's own spelling. */
  created_at: string;
  /** Set when the entry is withdrawn; the desktop removes it on its next sync. */
  deleted_at: string | null;
}

export type QueueStatus = "pending" | "sent" | "rejected";

export interface QueueItem {
  row: TimeEntryRow;
  status: QueueStatus;
  /** Bumped on every change, so an answer for an older version is ignored. */
  rev: number;
  attempts: number;
  queuedAt: string;
  sentAt?: string;
  /** Why the last attempt failed: a refusal code or a network message. */
  lastError?: string;
}

export interface QueueState {
  items: QueueItem[];
  /** The last `updated_at` this phone sent, in ms; stamps only move forward. */
  lastStamp: number;
}

export const EMPTY_QUEUE: QueueState = { items: [], lastStamp: 0 };

/** Sent items stay visible for a while, so the user sees them arrive. */
export const KEEP_SENT_MS = 3 * 86_400_000;

export type SendOutcome =
  | { kind: "ok" }
  | { kind: "transient"; message: string }
  | { kind: "rejected"; message: string };

/** Adds an entry, or replaces the waiting copy of the same entry. */
export function enqueue(state: QueueState, row: TimeEntryRow, nowIso: string): QueueState {
  const existing = state.items.find((item) => item.row.uuid === row.uuid);
  const item: QueueItem = {
    row,
    status: "pending",
    rev: (existing?.rev ?? 0) + 1,
    attempts: 0,
    queuedAt: nowIso,
  };
  const others = state.items.filter((entry) => entry.row.uuid !== row.uuid);
  return { ...state, items: [...others, item] };
}

/** Puts a rejected item back in line, unchanged. */
export function retry(state: QueueState, uuid: string): QueueState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.row.uuid === uuid && item.status === "rejected"
        ? { ...item, status: "pending", rev: item.rev + 1, attempts: 0, lastError: undefined }
        : item,
    ),
  };
}

/** Drops an item that has not reached the cloud. A sent item cannot be discarded here. */
export function discard(state: QueueState, uuid: string): QueueState {
  return { ...state, items: state.items.filter((item) => !(item.row.uuid === uuid && item.status !== "sent")) };
}

/** Forgets sent items older than KEEP_SENT_MS. */
export function prune(state: QueueState, nowMs: number): QueueState {
  const items = state.items.filter(
    (item) => item.status !== "sent" || !item.sentAt || nowMs - Date.parse(item.sentAt) < KEEP_SENT_MS,
  );
  return items.length === state.items.length ? state : { ...state, items };
}

export const pendingCount = (state: QueueState): number => state.items.filter((item) => item.status === "pending").length;

/**
 * The `updated_at` for the next write: the cloud's time, never earlier than
 * the phone's own clock, and always after the previous stamp, so two quick
 * changes to one entry cannot carry the same time (the cloud keeps the first
 * of two writes with equal times and silently drops the second).
 */
export function stampFor(serverMs: number, deviceMs: number, lastStamp: number): number {
  return Math.max(serverMs, deviceMs, lastStamp + 1);
}

/**
 * Reads the cloud's clock from an HTTP `Date` header. The header is whole
 * seconds, so the true time is up to a second later than it says; one second
 * is added so the estimate is never behind the cloud. Being a little ahead is
 * harmless; being behind is what loses rows.
 */
export function serverMsFromDateHeader(header: string | null | undefined): number | null {
  if (!header) return null;
  const parsed = Date.parse(header);
  return Number.isFinite(parsed) ? parsed + 1000 : null;
}

/** Errors that mean "try again later" rather than "the cloud said no". */
export function classifyError(error: { code?: string | null; message?: string | null; status?: number | null }): SendOutcome {
  const code = (error.code ?? "").trim();
  const message = error.message?.trim() || code || "unknown error";
  // No code at all: the request never got an answer (offline, DNS, timeout).
  if (!code) return { kind: "transient", message };
  // PostgREST's own codes: PGRST3xx is the login token (expired, being
  // refreshed); PGRST0xx is the connection to the database.
  if (/^PGRST[03]/.test(code)) return { kind: "transient", message };
  // Postgres classes that pass: 08 connection, 53 resources, 57 operator
  // intervention (restart, timeout), 40 serialization/deadlock.
  if (/^(08|53|57|40)/.test(code)) return { kind: "transient", message };
  if (error.status != null && error.status >= 500 && !/^[0-9A-Z]{5}$/.test(code)) return { kind: "transient", message };
  return { kind: "rejected", message: refusalCode(message) ?? code };
}

/** The guard's own reason codes, picked out of a Postgres message. */
export function refusalCode(message: string | null | undefined): string | null {
  const match = /TIME_ENTRY_[A-Z_]+/.exec(message ?? "");
  return match ? match[0] : null;
}

export interface FlushDeps {
  /** The cloud's current time in ms. Throws when the cloud cannot be reached. */
  serverNow(): Promise<number>;
  deviceNow(): number;
  /** Sends one row with the given updated_at. */
  send(row: TimeEntryRow & { updated_at: string }): Promise<SendOutcome>;
}

export interface FlushResult {
  /** Per entry: the rev that was attempted and what happened. */
  outcomes: { uuid: string; rev: number; outcome: SendOutcome; stamp?: number }[];
  /** Whether the run stopped early because the cloud was unreachable. */
  stoppedOffline: boolean;
}

/**
 * Sends every pending item, oldest first. It reads from `state` but does not
 * change it: the caller applies the result with `applyFlush`, against the
 * queue as it is THEN, because the user may have changed an entry while it was
 * being sent.
 */
export async function flush(state: QueueState, deps: FlushDeps): Promise<FlushResult> {
  const pending = state.items
    .filter((item) => item.status === "pending")
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  const outcomes: FlushResult["outcomes"] = [];
  if (pending.length === 0) return { outcomes, stoppedOffline: false };

  let serverMs: number;
  try {
    serverMs = await deps.serverNow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const item of pending) outcomes.push({ uuid: item.row.uuid, rev: item.rev, outcome: { kind: "transient", message } });
    return { outcomes, stoppedOffline: true };
  }

  // The cloud's clock moves on while we send; follow it with the phone's.
  const startedAt = deps.deviceNow();
  let lastStamp = state.lastStamp;
  for (const item of pending) {
    const elapsed = Math.max(0, deps.deviceNow() - startedAt);
    const stamp = stampFor(serverMs + elapsed, deps.deviceNow(), lastStamp);
    lastStamp = stamp;
    let outcome: SendOutcome;
    try {
      outcome = await deps.send({ ...item.row, updated_at: new Date(stamp).toISOString() });
    } catch (error) {
      outcome = { kind: "transient", message: error instanceof Error ? error.message : String(error) };
    }
    outcomes.push({ uuid: item.row.uuid, rev: item.rev, outcome, stamp });
    if (outcome.kind === "transient") {
      // Offline: the rest would fail the same way. Leave them waiting.
      for (const rest of pending.slice(pending.indexOf(item) + 1)) {
        outcomes.push({ uuid: rest.row.uuid, rev: rest.rev, outcome });
      }
      return { outcomes, stoppedOffline: true };
    }
  }
  return { outcomes, stoppedOffline: false };
}

/** Applies a flush result to the queue as it is now. */
export function applyFlush(state: QueueState, result: FlushResult, nowIso: string): QueueState {
  let lastStamp = state.lastStamp;
  const items = state.items.map((item) => {
    const done = result.outcomes.find((entry) => entry.uuid === item.row.uuid);
    if (done?.stamp !== undefined) lastStamp = Math.max(lastStamp, done.stamp);
    // Changed while it was being sent: the newer version is still to go.
    if (!done || done.rev !== item.rev || item.status !== "pending") return item;
    switch (done.outcome.kind) {
      case "ok":
        return { ...item, status: "sent" as const, sentAt: nowIso, attempts: item.attempts + 1, lastError: undefined };
      case "rejected":
        return { ...item, status: "rejected" as const, attempts: item.attempts + 1, lastError: done.outcome.message };
      case "transient":
        return { ...item, attempts: item.attempts + 1, lastError: done.outcome.message };
    }
  });
  return { items, lastStamp };
}

/** Reads a stored queue, tolerating an empty or damaged value. */
export function parseQueue(raw: string | null): QueueState {
  if (!raw) return EMPTY_QUEUE;
  try {
    const value = JSON.parse(raw) as Partial<QueueState>;
    const items = Array.isArray(value.items) ? value.items.filter((item) => item && typeof item.row?.uuid === "string") : [];
    return { items, lastStamp: typeof value.lastStamp === "number" ? value.lastStamp : 0 };
  } catch {
    return EMPTY_QUEUE;
  }
}
