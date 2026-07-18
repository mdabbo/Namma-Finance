import { describe, expect, it } from "vitest";
import type { Contract, Payment, PaymentAllocation, PaymentCertificate } from "../src/domain/types";
import { computeContractState, type ContractState } from "../src/calc/contract";
import { computeTeamPayout } from "../src/calc/teamPayout";

const TODAY = "2026-07-17";

function contract(over: Partial<Contract> = {}): Contract {
  return {
    id: 1,
    projectId: 1,
    number: "C-001",
    title: null,
    valueMinor: 100_000_000, // 1,000,000.00 EGP
    vatBp: 1400,
    retentionBp: 0,
    withholdingBp: 0,
    advanceMinor: 0,
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
    id: over.id ?? certSeq + 100,
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

function state(c: Contract, certificates: PaymentCertificate[], payments: Payment[] = [], allocations: PaymentAllocation[] = []): ContractState {
  return computeContractState({ contract: c, certificates, payments, allocations, todayIso: TODAY });
}

const MILESTONES = JSON.stringify([
  { title: "Concept", percentBp: 2000, certificateId: 11 },
  { title: "60% Design", percentBp: 3000, certificateId: 12 },
  { title: "IFC", percentBp: 5000, certificateId: null },
]);

describe("team payout — MILESTONES contract", () => {
  it("mirrors the contract milestones onto the assignment fee", () => {
    const c = contract({ valuationMode: "MILESTONES", milestones: MILESTONES });
    const payout = computeTeamPayout(5_000_000, [state(c, [])], 0); // fee 50,000.00
    expect(payout.stages.map((s) => s.title)).toEqual(["Concept", "60% Design", "IFC"]);
    expect(payout.stages.map((s) => s.amountMinor)).toEqual([1_000_000, 1_500_000, 2_500_000]);
    expect(payout.stages.every((s) => s.kind === "MILESTONE")).toBe(true);
    expect(payout.dueMinor).toBe(0);
  });

  it("releases a milestone when its linked certificate is PAID", () => {
    const c = contract({ valuationMode: "MILESTONES", milestones: MILESTONES });
    const certs = [
      cert({ id: 11, grossMinor: 20_000_000, status: "PAID" }),
      cert({ id: 12, grossMinor: 30_000_000, status: "SUBMITTED" }),
    ];
    const payout = computeTeamPayout(5_000_000, [state(c, certs)], 0);
    expect(payout.stages[0]!.status).toBe("PAYABLE");
    expect(payout.stages[1]!.status).toBe("AWAITING_COLLECTION");
    expect(payout.stages[2]!.status).toBe("PENDING");
    expect(payout.releasedMinor).toBe(1_000_000);
    expect(payout.dueMinor).toBe(1_000_000);
    expect(payout.dueTitles).toEqual(["Concept"]);
  });

  it("nets off person payments FIFO and marks stages paid out", () => {
    const c = contract({ valuationMode: "MILESTONES", milestones: MILESTONES });
    const certs = [
      cert({ id: 11, grossMinor: 20_000_000, status: "PAID" }),
      cert({ id: 12, grossMinor: 30_000_000, status: "PAID" }),
    ];
    // released = 1,000,000 + 1,500,000 = 2,500,000; already paid 1,200,000
    const payout = computeTeamPayout(5_000_000, [state(c, certs)], 1_200_000);
    expect(payout.stages[0]!.status).toBe("PAID_OUT");
    expect(payout.stages[1]!.status).toBe("PAYABLE");
    expect(payout.stages[1]!.paidOutMinor).toBe(200_000);
    expect(payout.dueMinor).toBe(1_300_000);
    expect(payout.dueTitles).toEqual(["60% Design"]);
  });

  it("overpayment floors the due amount at zero", () => {
    const c = contract({ valuationMode: "MILESTONES", milestones: MILESTONES });
    const certs = [cert({ id: 11, grossMinor: 20_000_000, status: "PAID" })];
    const payout = computeTeamPayout(5_000_000, [state(c, certs)], 9_999_999);
    expect(payout.dueMinor).toBe(0);
    expect(payout.dueTitles).toEqual([]);
  });

  it("allocates an odd fee exactly across milestones", () => {
    const c = contract({ valuationMode: "MILESTONES", milestones: MILESTONES });
    const payout = computeTeamPayout(1_000_001, [state(c, [])], 0);
    expect(payout.stages.reduce((s, x) => s + x.amountMinor, 0)).toBe(1_000_001);
  });
});

describe("team payout — LUMP_SUM contract (certificates are the stages)", () => {
  it("builds stages from certificates plus an uncertified remainder", () => {
    const c = contract(); // value 100,000,000
    const certs = [
      cert({ grossMinor: 40_000_000, status: "PAID", description: "First invoice" }),
      cert({ grossMinor: 25_000_000, status: "APPROVED" }),
    ];
    const payout = computeTeamPayout(10_000_000, [state(c, certs)], 0); // fee 100,000.00
    expect(payout.stages.map((s) => s.kind)).toEqual(["CERTIFICATE", "CERTIFICATE", "REMAINDER"]);
    expect(payout.stages[0]!.title).toBe("First invoice");
    expect(payout.stages.map((s) => s.amountMinor)).toEqual([4_000_000, 2_500_000, 3_500_000]);
    expect(payout.stages[0]!.status).toBe("PAYABLE");
    expect(payout.stages[1]!.status).toBe("AWAITING_COLLECTION");
    expect(payout.stages[2]!.status).toBe("PENDING");
    expect(payout.dueMinor).toBe(4_000_000);
  });

  it("certificate discounts shrink the stage share", () => {
    const c = contract();
    const certs = [cert({ grossMinor: 50_000_000, discountMinor: 10_000_000, status: "PAID" })];
    const payout = computeTeamPayout(10_000_000, [state(c, certs)], 0);
    // base = 40M of 100M → 40% of the fee
    expect(payout.stages[0]!.amountMinor).toBe(4_000_000);
    expect(payout.dueMinor).toBe(4_000_000);
  });
});

describe("team payout — edge cases", () => {
  it("no contracts yet → empty schedule, nothing due", () => {
    const payout = computeTeamPayout(5_000_000, [], 0);
    expect(payout.stages).toEqual([]);
    expect(payout.dueMinor).toBe(0);
  });

  it("zero fee → zero amounts everywhere", () => {
    const c = contract({ valuationMode: "MILESTONES", milestones: MILESTONES });
    const certs = [cert({ id: 11, grossMinor: 20_000_000, status: "PAID" })];
    const payout = computeTeamPayout(0, [state(c, certs)], 0);
    expect(payout.stages.every((s) => s.amountMinor === 0)).toBe(true);
    expect(payout.dueMinor).toBe(0);
  });

  it("spans multiple contracts of the project", () => {
    const c1 = contract({ id: 1, number: "C-001", valueMinor: 60_000_000 });
    const c2 = contract({ id: 2, number: "C-002", valueMinor: 40_000_000, valuationMode: "MILESTONES",
      milestones: JSON.stringify([{ title: "Phase A", percentBp: 10000, certificateId: 21 }]) });
    const paid = cert({ grossMinor: 60_000_000, status: "PAID" });
    const m = cert({ id: 21, contractId: 2, grossMinor: 40_000_000, status: "PAID" });
    const payout = computeTeamPayout(10_000_000, [state(c2, [m]), state(c1, [paid])], 0);
    // ordered by contract id: C-001 certificate stage first, then C-002 milestone
    expect(payout.stages.map((s) => s.contractNumber)).toEqual(["C-001", "C-002"]);
    expect(payout.stages.map((s) => s.amountMinor)).toEqual([6_000_000, 4_000_000]);
    expect(payout.dueMinor).toBe(10_000_000);
  });
});
