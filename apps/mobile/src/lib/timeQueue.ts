/**
 * The phone's outbox (plan steps F4, F5 and F6): time entries, payments to
 * the team (see lib/team.ts) and expense claims (lib/claimForm.ts). These are
 * the only three things the phone writes. A claim may carry a receipt photo,
 * which is uploaded before the claim itself is sent.
 *
 * Site signal is unreliable, so nothing is sent straight from a form: it is
 * put in this queue, kept on the phone, and sent when the cloud answers. Four
 * rules make that safe:
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

/**
 * A payment to a team member, in the cloud's column names, minus updated_at.
 * Payments are never changed or withdrawn from the phone: once in the cloud a
 * payment is fixed or voided on the desktop, which keeps its linked expense.
 */
export interface PersonPaymentRow {
  uuid: string;
  assignment_id: string;
  /** YYYY-MM-DD */
  date: string;
  amount_minor: number;
  note: string | null;
  /** Only earned payments, which the desktop caps at the amount due. */
  payment_kind: "EARNED";
  created_at: string;
}

/**
 * An expense claim in the cloud's column names, minus updated_at. It carries no
 * category, decision or rate: the office chooses those when it accepts the
 * claim, and leaving them out of what the phone sends means a phone write can
 * never overwrite them.
 */
export interface ExpenseClaimRow {
  uuid: string;
  /** The claimant. */
  person_id: string;
  project_id: string | null;
  /** YYYY-MM-DD */
  date: string;
  amount_minor: number;
  currency: string;
  description: string;
  supplier: string | null;
  /** "<login id>/claims/<claim uuid>.jpg", or null with no photo. */
  receipt_storage_key: string | null;
  receipt_sha256: string | null;
  /** When the phone filed it (ISO). */
  submitted_at: string;
  /** "YYYY-MM-DD HH:MM:SS" in UTC, the desktop's own spelling. */
  created_at: string;
  /** Set when the claim is withdrawn while still waiting for a decision. */
  deleted_at: string | null;
}

/** The cloud tables the outbox writes. Nothing else is written from the phone. */
export const OUTBOX_TABLES = ["time_entries", "person_payments", "expense_claims"] as const;
export type OutboxTable = (typeof OUTBOX_TABLES)[number];

export type QueueStatus = "pending" | "sent" | "rejected";

interface QueueItemBase {
  status: QueueStatus;
  /** Bumped on every change, so an answer for an older version is ignored. */
  rev: number;
  attempts: number;
  queuedAt: string;
  sentAt?: string;
  /** Why the last attempt failed: a refusal code or a network message. */
  lastError?: string;
}

export type QueueItem =
  | (QueueItemBase & { table: "time_entries"; row: TimeEntryRow })
  | (QueueItemBase & { table: "person_payments"; row: PersonPaymentRow })
  | (QueueItemBase & {
      table: "expense_claims";
      row: ExpenseClaimRow;
      /** The compressed receipt kept on the phone until it has been uploaded. */
      attachmentPath?: string;
    });

export type OutboxRow = QueueItem["row"];

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

/** Adds a time entry, or replaces the waiting copy of the same entry. */
export function enqueue(state: QueueState, row: TimeEntryRow, nowIso: string): QueueState {
  return put(state, { table: "time_entries", row }, nowIso);
}

/**
 * Adds a payment. A payment is added once: the same uuid again (a double tap)
 * changes nothing, because a payment is never edited from the phone.
 */
export function enqueuePayment(state: QueueState, row: PersonPaymentRow, nowIso: string): QueueState {
  if (state.items.some((item) => item.row.uuid === row.uuid)) return state;
  return put(state, { table: "person_payments", row }, nowIso);
}

/**
 * Files a claim, or replaces its waiting copy: withdrawing a claim that has not
 * been sent yet simply replaces it, and one already sent becomes a new item.
 */
export function enqueueClaim(state: QueueState, row: ExpenseClaimRow, attachmentPath: string | undefined, nowIso: string): QueueState {
  return put(state, { table: "expense_claims", row, ...(attachmentPath ? { attachmentPath } : {}) }, nowIso);
}

/**
 * The photo files no longer needed: those of items that were dropped between two
 * states (discarded or forgotten after being sent). The caller deletes them.
 */
export function releasedAttachments(before: QueueState, after: QueueState): string[] {
  const kept = new Set(after.items.flatMap((item) => (item.table === "expense_claims" && item.attachmentPath ? [item.attachmentPath] : [])));
  return before.items.flatMap((item) =>
    item.table === "expense_claims" && item.attachmentPath && !kept.has(item.attachmentPath) ? [item.attachmentPath] : [],
  );
}

type QueueEntry =
  | { table: "time_entries"; row: TimeEntryRow }
  | { table: "person_payments"; row: PersonPaymentRow }
  | { table: "expense_claims"; row: ExpenseClaimRow; attachmentPath?: string };

function put(state: QueueState, entry: QueueEntry, nowIso: string): QueueState {
  const row = entry.row;
  const existing = state.items.find((item) => item.row.uuid === row.uuid);
  const item = {
    ...entry,
    status: "pending",
    rev: (existing?.rev ?? 0) + 1,
    attempts: 0,
    queuedAt: nowIso,
  } as QueueItem;
  const others = state.items.filter((other) => other.row.uuid !== row.uuid);
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
  /**
   * Sends one row, with the given updated_at, to its table. A claim's receipt
   * path comes along so it can be uploaded first.
   */
  send(row: OutboxRow & { updated_at: string }, table: OutboxTable, attachmentPath?: string): Promise<SendOutcome>;
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
      outcome = await deps.send(
        { ...item.row, updated_at: new Date(stamp).toISOString() },
        item.table,
        item.table === "expense_claims" ? item.attachmentPath : undefined,
      );
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
      case "ok": {
        const sent = { ...item, status: "sent" as const, sentAt: nowIso, attempts: item.attempts + 1, lastError: undefined };
        // The photo is in the cloud now; the file on the phone is no longer needed.
        if (sent.table === "expense_claims") delete sent.attachmentPath;
        return sent;
      }
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
    // Items saved before payments existed carry no table: they are time entries.
    const items = Array.isArray(value.items)
      ? value.items
          .filter((item) => item && typeof item.row?.uuid === "string")
          .map((item) => ({ ...item, table: OUTBOX_TABLES.includes(item.table) ? item.table : "time_entries" }) as QueueItem)
      : [];
    return { items, lastStamp: typeof value.lastStamp === "number" ? value.lastStamp : 0 };
  } catch {
    return EMPTY_QUEUE;
  }
}
