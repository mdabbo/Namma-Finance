import { computeTeamPayout, parseContractFees, type ContractState, type TeamStage } from "@mep/core";
import { isDateOpen } from "./timeEntryForm";
import type { PersonPaymentRow, QueueItem } from "./timeQueue";

/**
 * Each team member's position on a project, and the rules for paying them
 * from the phone.
 *
 * "Due" here must equal the desktop's, because the desktop checks every
 * payment the phone sends against its own figure (`assignment_person_payment_due`
 * in lib.rs) and refuses one that is larger. So this follows that function:
 *
 * - paid   = the assignment's payments that are not voided (any kind);
 * - earned = the stages released by collected certificates (the shared
 *            `computeTeamPayout`), or, for a cancelled assignment, the amount
 *            frozen when it was cancelled;
 * - due    = earned − paid, never below zero;
 * - an archived assignment, person or project cannot be paid.
 *
 * No React Native here; tested in apps/desktop/test/mobile-team.test.ts.
 */

type Row = Record<string, unknown>;

export type Lifecycle = "ACTIVE" | "COMPLETED" | "CANCELLED";

export interface TeamPaymentRecord {
  uuid: string;
  date: string;
  amountMinor: number;
  note: string | null;
  kind: "EARNED" | "SPECIAL";
  voided: boolean;
}

export interface TeamMember {
  assignmentUuid: string;
  personName: string;
  currency: string;
  lifecycle: Lifecycle;
  agreedMinor: number;
  /** Released by collected certificates (frozen if cancelled). */
  earnedMinor: number;
  /** Not voided. */
  paidMinor: number;
  /** What may be paid now: earned − paid. */
  dueMinor: number;
  /** Still to pay over the life of the assignment. */
  remainingMinor: number;
  stages: TeamStage[];
  /** Newest first, voided ones included so the history is complete. */
  payments: TeamPaymentRecord[];
  /** False when the assignment, the person or the project is archived. */
  payable: boolean;
}

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0)) || 0;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** One assignment's position, from cloud rows. */
export function teamMemberStatus(input: {
  assignment: Row;
  personName: string;
  personArchived: boolean;
  projectCurrency: string;
  contractStates: ContractState[];
  paymentRows: Row[];
}): TeamMember {
  const a = input.assignment;
  const live = input.paymentRows.filter((row) => row.voided_at == null);
  const paidMinor = live.reduce((sum, row) => sum + num(row.amount_minor), 0);
  const agreedMinor = num(a.agreed_minor);
  const lifecycle: Lifecycle = a.lifecycle_status === "CANCELLED" ? "CANCELLED" : a.lifecycle_status === "COMPLETED" ? "COMPLETED" : "ACTIVE";
  const payout = computeTeamPayout(
    agreedMinor,
    input.contractStates,
    paidMinor,
    parseContractFees(typeof a.contract_fees === "string" ? a.contract_fees : null),
  );
  const earnedMinor = lifecycle === "CANCELLED" ? Math.max(0, num(a.earned_minor_at_cancellation)) : Math.max(0, payout.releasedMinor);
  const dueMinor = Math.max(0, earnedMinor - paidMinor);
  // A cancelled assignment will never earn more than it had when cancelled.
  const remainingMinor = Math.max(0, (lifecycle === "CANCELLED" ? earnedMinor : agreedMinor) - paidMinor);
  const payments = input.paymentRows
    .map((row) => ({
      uuid: str(row.uuid),
      date: str(row.date),
      amountMinor: num(row.amount_minor),
      note: typeof row.note === "string" && row.note ? row.note : null,
      kind: row.payment_kind === "SPECIAL" ? ("SPECIAL" as const) : ("EARNED" as const),
      voided: row.voided_at != null,
    }))
    .sort((x, y) => y.date.localeCompare(x.date));
  return {
    assignmentUuid: str(a.uuid),
    personName: input.personName,
    currency: str(a.currency) || input.projectCurrency,
    lifecycle,
    agreedMinor,
    earnedMinor,
    paidMinor,
    dueMinor,
    remainingMinor,
    stages: payout.stages,
    payments,
    payable: a.archived_at == null && !input.personArchived,
  };
}

/** Arabic-Indic and Persian digits to 0-9; Arabic marks to "." and "". */
function westernDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/[٬,\s]/g, "");
}

/**
 * A typed amount in whole minor units, read as text so no floating point is
 * involved: "1500", "1,500.50", "١٬٥٠٠٫٥" → 150050 with 2 decimals. A comma is
 * a thousands separator here (amounts are written "1,500"). Null for anything
 * that is not a positive amount with at most `exponent` decimals.
 */
export function parseAmountMinor(text: string, exponent: number): number | null {
  const value = westernDigits(text.trim());
  const match = /^(\d{1,12})(?:\.(\d*))?$/.exec(value) ?? /^()\.(\d+)$/.exec(value);
  if (!match) return null;
  const whole = match[1] || "0";
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) return null;
  const minor = Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** Minor units as an editable amount, e.g. 150050 → "1500.5". */
export function amountText(minor: number, exponent: number): string {
  const whole = Math.floor(minor / 10 ** exponent);
  const fraction = String(minor % 10 ** exponent).padStart(exponent, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * Payments this phone has queued for an assignment that the loaded cloud
 * figures do not include yet: still waiting, refused, or sent after the
 * figures were loaded. They count against what may still be paid.
 */
export function queuedNotLoaded(items: QueueItem[], member: TeamMember): PersonPaymentRow[] {
  const loaded = new Set(member.payments.map((payment) => payment.uuid));
  return items
    .filter((item): item is Extract<QueueItem, { table: "person_payments" }> => item.table === "person_payments")
    .map((item) => item.row)
    .filter((row) => row.assignment_id === member.assignmentUuid && !loaded.has(row.uuid));
}

/** What may still be paid now, after this phone's queued payments. */
export function availableDue(member: TeamMember, items: QueueItem[]): number {
  const queued = queuedNotLoaded(items, member).reduce((sum, row) => sum + row.amount_minor, 0);
  return Math.max(0, member.dueMinor - queued);
}

export type PaymentError = "not_payable" | "amount" | "exceeds_due" | "date" | "duplicate";

export interface PaymentDraft {
  amount: string;
  date: string;
  note: string;
}

/**
 * Checks a payment before it is queued, with the desktop's own rules: a
 * positive amount, no more than is due now, not archived, and not an exact
 * copy (same date, amount and note) of a payment already recorded — the
 * desktop refuses such a twin as a duplicate.
 */
export function validatePayment(
  draft: PaymentDraft,
  member: TeamMember,
  items: QueueItem[],
  today: string,
  exponent: number,
): PaymentError[] {
  if (!member.payable) return ["not_payable"];
  const errors: PaymentError[] = [];
  const amount = parseAmountMinor(draft.amount, exponent);
  if (amount === null) errors.push("amount");
  else if (amount > availableDue(member, items)) errors.push("exceeds_due");
  if (!isDateOpen(draft.date, today)) errors.push("date");
  if (amount !== null) {
    const note = draft.note.trim() || null;
    const twin =
      member.payments.some((p) => !p.voided && p.kind === "EARNED" && p.date === draft.date && p.amountMinor === amount && p.note === note) ||
      queuedNotLoaded(items, member).some((p) => p.date === draft.date && p.amount_minor === amount && p.note === note);
    if (twin) errors.push("duplicate");
  }
  return errors;
}

/** The row the outbox sends for a valid draft. */
export function paymentRow(draft: PaymentDraft, member: TeamMember, exponent: number, ids: { uuid: string; createdAt: string }): PersonPaymentRow {
  return {
    uuid: ids.uuid,
    assignment_id: member.assignmentUuid,
    date: draft.date,
    amount_minor: parseAmountMinor(draft.amount, exponent)!,
    note: draft.note.trim() || null,
    payment_kind: "EARNED",
    created_at: ids.createdAt,
  };
}

