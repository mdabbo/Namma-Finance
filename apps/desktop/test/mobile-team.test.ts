import { describe, expect, it } from "vitest";
import { computeTeamPayout, type ContractState } from "@mep/core";
import {
  amountText,
  availableDue,
  parseAmountMinor,
  paymentRow,
  teamMemberStatus,
  validatePayment,
  type PaymentDraft,
  type TeamMember,
} from "../../mobile/src/lib/team";
import { EMPTY_QUEUE, enqueue, enqueuePayment, flush, parseQueue, type PersonPaymentRow, type QueueItem } from "../../mobile/src/lib/timeQueue";
import { loadMobileWorkspace } from "../../mobile/src/lib/workspace";
import { createPreviewClient } from "../../mobile/src/preview/previewClient";

/**
 * The team on the phone: each member's agreed, earned, paid and due figures,
 * and paying them from the phone. "Due" must equal the desktop's
 * (`assignment_person_payment_due` in lib.rs), because the desktop refuses a
 * phone payment larger than its own figure.
 */

/** A lump-sum contract of 1,000.00 with one PAID certificate of 400.00. */
const STATES = [
  {
    contract: { id: 1, number: "C-1", valueMinor: 100_000, valuationMode: "LUMP_SUM", milestones: null },
    certificates: [{ certificate: { id: 1, status: "PAID", description: "Stage 1", number: "PC-1" }, breakdown: { baseMinor: 40_000 } }],
  },
] as unknown as ContractState[];

const RELEASED = computeTeamPayout(10_000, STATES, 0).releasedMinor; // 40% of 100.00

function member(overrides: { assignment?: Record<string, unknown>; payments?: Record<string, unknown>[]; personArchived?: boolean } = {}): TeamMember {
  return teamMemberStatus({
    assignment: { uuid: "as-1", agreed_minor: 10_000, currency: "EGP", lifecycle_status: "ACTIVE", archived_at: null, ...overrides.assignment },
    personName: "Omar",
    personArchived: overrides.personArchived ?? false,
    projectCurrency: "EGP",
    contractStates: STATES,
    paymentRows: overrides.payments ?? [],
  });
}

const pay = (uuid: string, amount: number, extra: Record<string, unknown> = {}) => ({
  uuid, assignment_id: "as-1", date: "2026-11-10", amount_minor: amount, note: null, payment_kind: "EARNED", voided_at: null, ...extra,
});

describe("a team member's figures", () => {
  it("earns what collected certificates released, and owes that less what was paid", () => {
    expect(RELEASED).toBe(4_000);
    const m = member({ payments: [pay("p1", 1_500)] });
    expect(m).toMatchObject({ agreedMinor: 10_000, earnedMinor: 4_000, paidMinor: 1_500, dueMinor: 2_500, remainingMinor: 8_500, payable: true });
  });

  it("does not count voided payments as paid", () => {
    const m = member({ payments: [pay("p1", 1_000), pay("p2", 3_000, { voided_at: "2026-11-11T00:00:00Z" })] });
    expect(m.paidMinor).toBe(1_000);
    expect(m.dueMinor).toBe(3_000);
    expect(m.payments.find((p) => p.uuid === "p2")!.voided).toBe(true);
  });

  it("counts special payments as paid, as the desktop does", () => {
    expect(member({ payments: [pay("p1", 1_000, { payment_kind: "SPECIAL" })] }).dueMinor).toBe(3_000);
  });

  it("keeps a cancelled assignment's earnings frozen at cancellation", () => {
    const m = member({ assignment: { lifecycle_status: "CANCELLED", earned_minor_at_cancellation: 2_000 }, payments: [pay("p1", 500)] });
    expect(m).toMatchObject({ lifecycle: "CANCELLED", earnedMinor: 2_000, dueMinor: 1_500, remainingMinor: 1_500 });
  });

  it("never owes a negative amount", () => {
    expect(member({ payments: [pay("p1", 9_000, { payment_kind: "SPECIAL" })] }).dueMinor).toBe(0);
  });

  it("cannot be paid when the assignment or the person is archived", () => {
    expect(member({ assignment: { archived_at: "2026-11-01" } }).payable).toBe(false);
    expect(member({ personArchived: true }).payable).toBe(false);
  });

  it("lists payments newest first", () => {
    const m = member({ payments: [pay("old", 100, { date: "2026-10-01" }), pay("new", 100, { date: "2026-11-01" })] });
    expect(m.payments.map((p) => p.uuid)).toEqual(["new", "old"]);
  });
});

describe("typed amounts", () => {
  it("reads amounts as text into whole minor units", () => {
    expect(parseAmountMinor("1500", 2)).toBe(150_000);
    expect(parseAmountMinor("1,500.50", 2)).toBe(150_050);
    expect(parseAmountMinor("١٬٥٠٠٫٥", 2)).toBe(150_050);
    expect(parseAmountMinor(" 0.05 ", 2)).toBe(5);
    expect(parseAmountMinor(".5", 2)).toBe(50);
    expect(parseAmountMinor("1.125", 3)).toBe(1_125); // KWD
    for (const bad of ["", "0", "0.00", "-5", "abc", "1.234", "1.2.3", "1e5"]) expect(parseAmountMinor(bad, 2)).toBeNull();
  });

  it("writes minor units back as an editable amount", () => {
    expect(amountText(150_050, 2)).toBe("1500.5");
    expect(amountText(150_000, 2)).toBe("1500");
    expect(amountText(5, 2)).toBe("0.05");
    expect(parseAmountMinor(amountText(123_457, 2), 2)).toBe(123_457);
  });
});

describe("paying from the phone", () => {
  const today = "2026-11-20";
  const draft = (overrides: Partial<PaymentDraft> = {}): PaymentDraft => ({ amount: "25", date: today, note: "", ...overrides });
  const queued = (row: Partial<PersonPaymentRow> = {}): QueueItem[] =>
    enqueuePayment(EMPTY_QUEUE, { uuid: "q1", assignment_id: "as-1", date: today, amount_minor: 1_000, note: null, payment_kind: "EARNED", created_at: "x", ...row }, "t").items;

  it("accepts a payment up to what is due", () => {
    expect(validatePayment(draft({ amount: "40" }), member(), [], today, 2)).toEqual([]);
    expect(validatePayment(draft({ amount: "40.01" }), member(), [], today, 2)).toEqual(["exceeds_due"]);
  });

  it("counts this phone's queued payments that the figures do not show yet", () => {
    const items = queued();
    expect(availableDue(member(), items)).toBe(3_000);
    expect(validatePayment(draft({ amount: "30.01" }), member(), items, today, 2)).toEqual(["exceeds_due"]);
    // Once the cloud figures include it, it is not counted twice.
    expect(availableDue(member({ payments: [pay("q1", 1_000)] }), items)).toBe(3_000);
    // Payments for someone else, and time entries, do not count.
    expect(availableDue(member(), queued({ assignment_id: "as-2" }))).toBe(4_000);
    const timeOnly = enqueue(EMPTY_QUEUE, { uuid: "t1", person_id: "p", project_id: "pr", stage_id: null, date: today, minutes: 60, billable: 1, note: null, created_at: "x", deleted_at: null }, "t").items;
    expect(availableDue(member(), timeOnly)).toBe(4_000);
  });

  it("refuses a bad amount, an old date, and an archived member", () => {
    expect(validatePayment(draft({ amount: "abc" }), member(), [], today, 2)).toEqual(["amount"]);
    expect(validatePayment(draft({ date: "2026-11-01" }), member(), [], today, 2)).toEqual(["date"]);
    expect(validatePayment(draft(), member({ personArchived: true }), [], today, 2)).toEqual(["not_payable"]);
  });

  it("refuses an exact copy of a recorded payment, as the desktop would", () => {
    const recorded = member({ payments: [pay("p1", 500, { date: today, note: "site" })] });
    expect(validatePayment(draft({ amount: "5", note: " site " }), recorded, [], today, 2)).toEqual(["duplicate"]);
    expect(validatePayment(draft({ amount: "5", note: "other" }), recorded, [], today, 2)).toEqual([]);
    const voided = member({ payments: [pay("p1", 500, { date: today, voided_at: "x" })] });
    expect(validatePayment(draft({ amount: "5" }), voided, [], today, 2)).toEqual([]);
    expect(validatePayment(draft({ amount: "10" }), member(), queued(), today, 2)).toEqual(["duplicate"]);
  });

  it("builds an earned payment row for the member's assignment", () => {
    expect(paymentRow(draft({ amount: "1,234.5", note: "  first  " }), member(), 2, { uuid: "u", createdAt: "2026-11-20 08:00:00" })).toEqual({
      uuid: "u", assignment_id: "as-1", date: today, amount_minor: 123_450, note: "first", payment_kind: "EARNED", created_at: "2026-11-20 08:00:00",
    });
  });
});

describe("payments in the outbox", () => {
  const row: PersonPaymentRow = { uuid: "u1", assignment_id: "as-1", date: "2026-11-20", amount_minor: 100, note: null, payment_kind: "EARNED", created_at: "x" };

  it("adds a payment once, even on a double tap", () => {
    const once = enqueuePayment(EMPTY_QUEUE, row, "a");
    expect(enqueuePayment(once, { ...row, amount_minor: 999 }, "b")).toBe(once);
    expect(once.items).toHaveLength(1);
  });

  it("sends payments to person_payments and time entries to time_entries", async () => {
    let state = enqueuePayment(EMPTY_QUEUE, row, "a");
    state = enqueue(state, { uuid: "t1", person_id: "p", project_id: "pr", stage_id: null, date: "2026-11-20", minutes: 60, billable: 1, note: null, created_at: "x", deleted_at: null }, "b");
    const sent: [string, string][] = [];
    await flush(state, {
      serverNow: async () => 1_000,
      deviceNow: () => 1_000,
      send: async (next, table) => {
        sent.push([next.uuid, table]);
        return { kind: "ok" };
      },
    });
    expect(sent).toEqual([["u1", "person_payments"], ["t1", "time_entries"]]);
  });

  it("reads a queue saved before payments existed as time entries", () => {
    const old = JSON.stringify({ items: [{ row: { uuid: "t1" }, status: "pending", rev: 1, attempts: 0, queuedAt: "a" }], lastStamp: 0 });
    expect(parseQueue(old).items[0]!.table).toBe("time_entries");
  });
});

describe("the team on the preview data, through the real workspace loader", () => {
  it("lists each project's team and alerts exactly the payable amounts due", async () => {
    const ws = await loadMobileWorkspace(createPreviewClient());
    const members = [...ws.team.values()].flat();
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) {
      expect(m.dueMinor).toBe(Math.max(0, m.earnedMinor - m.paidMinor));
      expect(m.paidMinor).toBe(m.payments.filter((p) => !p.voided).reduce((s, p) => s + p.amountMinor, 0));
    }
    // The sample data holds an archived assignment with money due: no alert for it.
    expect(members.some((m) => !m.payable && m.dueMinor > 0)).toBe(true);
    const due = members.filter((m) => m.payable && m.dueMinor > 0);
    expect(ws.teamPayables.map((a) => a.amountMinor).sort()).toEqual(due.map((m) => m.dueMinor).sort());
  });
});
