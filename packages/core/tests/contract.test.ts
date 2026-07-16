import { describe, expect, it } from "vitest";
import type { Contract, Payment, PaymentAllocation, PaymentCertificate } from "../src/domain/types";
import { computeContractState, deriveContractFigures } from "../src/calc/contract";

const TODAY = "2026-07-15";

function contract(over: Partial<Contract> = {}): Contract {
  return {
    id: 1,
    projectId: 1,
    number: "C-001",
    title: null,
    valueMinor: 100_000_000, // 1,000,000.00 EGP
    vatBp: 1400,
    retentionBp: 500,
    withholdingBp: 0,
    advanceMinor: 10_000_000, // 100,000.00 EGP
    advanceRecoveryMethod: "PROPORTIONAL",
    performanceBondBp: 0,
    performanceBondBank: null,
    performanceBondExpiry: null,
    paymentTermsDays: 30,
    paymentTermsNotes: null,
    valuationMode: "LUMP_SUM",
    milestones: null,
    drawings: null,
    attachments: null,
    signedDate: null,
    notes: null,
    createdAt: "2026-01-01",
    ...over,
  };
}

let certSeq = 0;
function cert(over: Partial<PaymentCertificate> = {}): PaymentCertificate {
  certSeq += 1;
  return {
    id: certSeq,
    contractId: 1,
    seq: certSeq,
    number: `PC-${certSeq}`,
    date: "2026-02-01",
    submissionDate: "2026-02-01",
    dueDateOverride: null,
    description: null,
    grossMinor: 10_000_000,
    discountMinor: 0,
    manualAdvanceRecoveryMinor: null,
    status: "APPROVED",
    deletedAt: null,
    createdAt: "2026-02-01",
    ...over,
  };
}

function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: 1,
    contractId: 1,
    kind: "CERTIFICATE",
    number: "P-1",
    date: "2026-03-01",
    amountMinor: 0,
    method: "BANK_TRANSFER",
    bank: null,
    reference: null,
    notes: null,
    deletedAt: null,
    createdAt: "2026-03-01",
    ...over,
  };
}

function alloc(paymentId: number, certificateId: number, amountMinor: number): PaymentAllocation {
  return { id: paymentId * 100 + certificateId, paymentId, certificateId, amountMinor };
}

describe("contract-level derived figures", () => {
  it("computes VAT amount, retention amount, net contract value", () => {
    const f = deriveContractFigures({ valueMinor: 100_000_000, vatBp: 1400, retentionBp: 500 });
    expect(f.vatMinor).toBe(14_000_000);
    expect(f.retentionMinor).toBe(5_000_000);
    expect(f.netContractMinor).toBe(109_000_000);
  });
});

describe("advance-recovery threading across certificates", () => {
  it("threads recovery in seq order and never exceeds the advance", () => {
    // 3 certificates of 400,000 EGP each = 1.2M certified > 1M contract value.
    // 10% proportional recovery: 40,000 + 40,000, then capped at 20,000 remaining.
    const c = contract();
    const certs = [
      cert({ id: 1, seq: 1, grossMinor: 40_000_000 }),
      cert({ id: 2, seq: 2, grossMinor: 40_000_000 }),
      cert({ id: 3, seq: 3, grossMinor: 40_000_000 }),
    ];
    const state = computeContractState({ contract: c, certificates: certs, payments: [], allocations: [], todayIso: TODAY });
    const recoveries = state.certificates.map((s) => s.breakdown.advanceRecoveryMinor);
    expect(recoveries).toEqual([4_000_000, 4_000_000, 2_000_000]);
    expect(state.advanceRecoveredMinor).toBe(10_000_000);
    expect(state.advanceRemainingMinor).toBe(0);
  });

  it("rounding drift across many certificates never over-recovers", () => {
    // 7 odd-valued certificates; every proportional recovery rounds.
    const c = contract({ valueMinor: 99_999_999, advanceMinor: 9_999_999 });
    const certs = Array.from({ length: 7 }, (_, i) =>
      cert({ id: i + 1, seq: i + 1, grossMinor: 14_285_713 }),
    );
    const state = computeContractState({ contract: c, certificates: certs, payments: [], allocations: [], todayIso: TODAY });
    expect(state.advanceRecoveredMinor).toBeLessThanOrEqual(9_999_999);
    expect(state.advanceRemainingMinor).toBeGreaterThanOrEqual(0);
  });

  it("drafts do not consume the advance", () => {
    const c = contract();
    const certs = [
      cert({ id: 1, seq: 1, grossMinor: 40_000_000, status: "DRAFT" }),
      cert({ id: 2, seq: 2, grossMinor: 40_000_000, status: "APPROVED" }),
    ];
    const state = computeContractState({ contract: c, certificates: certs, payments: [], allocations: [], todayIso: TODAY });
    // The draft shows a provisional recovery but only the approved one counts.
    expect(state.advanceRecoveredMinor).toBe(4_000_000);
    expect(state.certifiedBaseMinor).toBe(40_000_000);
  });

  it("soft-deleted certificates are excluded entirely", () => {
    const c = contract();
    const certs = [
      cert({ id: 1, seq: 1, grossMinor: 40_000_000, deletedAt: "2026-05-01" }),
      cert({ id: 2, seq: 2, grossMinor: 40_000_000 }),
    ];
    const state = computeContractState({ contract: c, certificates: certs, payments: [], allocations: [], todayIso: TODAY });
    expect(state.certificates).toHaveLength(1);
    expect(state.certifiedBaseMinor).toBe(40_000_000);
  });
});

describe("retention lifecycle", () => {
  it("accumulates retention per certificate and reduces it on release", () => {
    const c = contract({ advanceMinor: 0 });
    const certs = [
      cert({ id: 1, seq: 1, grossMinor: 40_000_000 }),
      cert({ id: 2, seq: 2, grossMinor: 60_000_000 }),
    ];
    const payments = [
      payment({ id: 1, kind: "RETENTION_RELEASE", amountMinor: 2_000_000 }),
    ];
    const state = computeContractState({ contract: c, certificates: certs, payments, allocations: [], todayIso: TODAY });
    expect(state.retentionWithheldMinor).toBe(5_000_000); // 5% of 1,000,000 EGP
    expect(state.retentionReleasedMinor).toBe(2_000_000);
    expect(state.retentionHeldMinor).toBe(3_000_000);
  });
});

describe("collection and outstanding balances", () => {
  it("computes due, paid, outstanding and collection % from allocations", () => {
    const c = contract({ advanceMinor: 0, retentionBp: 0, vatBp: 0 });
    const certs = [
      cert({ id: 1, seq: 1, grossMinor: 40_000_000 }),
      cert({ id: 2, seq: 2, grossMinor: 60_000_000 }),
    ];
    const payments = [payment({ id: 1, amountMinor: 50_000_000 })];
    const allocations = [alloc(1, 1, 40_000_000), alloc(1, 2, 10_000_000)];
    const state = computeContractState({ contract: c, certificates: certs, payments, allocations, todayIso: TODAY });
    expect(state.totalDueMinor).toBe(100_000_000);
    expect(state.totalPaidMinor).toBe(50_000_000);
    expect(state.outstandingMinor).toBe(50_000_000);
    expect(state.collectionRatioBp).toBe(5000); // 50%
    expect(state.certificates[0]!.unpaidMinor).toBe(0);
    expect(state.certificates[1]!.unpaidMinor).toBe(50_000_000);
  });

  it("ignores allocations belonging to soft-deleted payments", () => {
    const c = contract({ advanceMinor: 0, retentionBp: 0, vatBp: 0 });
    const certs = [cert({ id: 1, seq: 1, grossMinor: 40_000_000 })];
    const payments = [payment({ id: 1, amountMinor: 40_000_000, deletedAt: "2026-05-01" })];
    const allocations = [alloc(1, 1, 40_000_000)];
    const state = computeContractState({ contract: c, certificates: certs, payments, allocations, todayIso: TODAY });
    expect(state.totalPaidMinor).toBe(0);
    expect(state.outstandingMinor).toBe(40_000_000);
  });

  it("tracks total cash-in including advance and retention release", () => {
    const c = contract({ advanceMinor: 10_000_000 });
    const certs = [cert({ id: 1, seq: 1, grossMinor: 40_000_000 })];
    const payments = [
      payment({ id: 1, kind: "ADVANCE", amountMinor: 10_000_000 }),
      payment({ id: 2, kind: "CERTIFICATE", amountMinor: 20_000_000 }),
      payment({ id: 3, kind: "RETENTION_RELEASE", amountMinor: 1_000_000 }),
    ];
    const allocations = [alloc(2, 1, 20_000_000)];
    const state = computeContractState({ contract: c, certificates: certs, payments, allocations, todayIso: TODAY });
    expect(state.advanceReceivedMinor).toBe(10_000_000);
    expect(state.totalCashInMinor).toBe(31_000_000);
  });

  it("remaining un-certified value decreases as certificates are issued", () => {
    const c = contract();
    const certs = [cert({ id: 1, seq: 1, grossMinor: 30_000_000 })];
    const state = computeContractState({ contract: c, certificates: certs, payments: [], allocations: [], todayIso: TODAY });
    expect(state.remainingUncertifiedMinor).toBe(70_000_000);
    expect(state.certifiedRatioBp).toBe(3000); // 30%
  });
});

describe("overdue detection inside contract state", () => {
  it("flags unpaid certificates past submission + payment terms", () => {
    const c = contract({ advanceMinor: 0, paymentTermsDays: 30 });
    const certs = [
      cert({ id: 1, seq: 1, submissionDate: "2026-05-01", status: "SUBMITTED" }), // due 2026-05-31, overdue
      cert({ id: 2, seq: 2, submissionDate: "2026-07-01", status: "SUBMITTED" }), // due 2026-07-31, not yet
    ];
    const state = computeContractState({ contract: c, certificates: certs, payments: [], allocations: [], todayIso: TODAY });
    expect(state.certificates[0]!.overdue).toBe(true);
    expect(state.certificates[0]!.dueDate).toBe("2026-05-31");
    expect(state.certificates[1]!.overdue).toBe(false);
  });

  it("respects the manual due-date override", () => {
    const c = contract({ advanceMinor: 0, paymentTermsDays: 30 });
    const certs = [
      cert({ id: 1, seq: 1, submissionDate: "2026-05-01", dueDateOverride: "2026-12-31", status: "SUBMITTED" }),
    ];
    const state = computeContractState({ contract: c, certificates: certs, payments: [], allocations: [], todayIso: TODAY });
    expect(state.certificates[0]!.overdue).toBe(false);
    expect(state.certificates[0]!.dueDate).toBe("2026-12-31");
  });

  it("fully paid and draft certificates are never overdue", () => {
    const c = contract({ advanceMinor: 0, retentionBp: 0, vatBp: 0, paymentTermsDays: 0 });
    const certs = [
      cert({ id: 1, seq: 1, grossMinor: 1_000, submissionDate: "2026-01-01", status: "PAID" }),
      cert({ id: 2, seq: 2, grossMinor: 1_000, submissionDate: "2026-01-01", status: "DRAFT" }),
    ];
    const payments = [payment({ id: 1, amountMinor: 1_000 })];
    const allocations = [alloc(1, 1, 1_000)];
    const state = computeContractState({ contract: c, certificates: certs, payments, allocations, todayIso: TODAY });
    expect(state.certificates.every((s) => !s.overdue)).toBe(true);
  });
});
