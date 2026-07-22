import { describe, expect, it } from "vitest";
import type { Contract, Expense, PaymentCertificate, Project } from "../src/domain/types";
import { computeContractState } from "../src/calc/contract";
import {
  computeAssignmentAccount,
  computeClientFinancials,
  computeDashboardKpis,
  computeProjectFinancials,
} from "../src/calc/aggregate";
import { suggestAllocation } from "../src/calc/allocation";

const TODAY = "2026-07-15";

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1,
    code: "PRJ-2026-001",
    name: "Tower HVAC design",
    clientId: 1,
    country: "Egypt",
    city: "Cairo",
    manager: null,
    discipline: "HVAC",
    projectType: null,
    status: "ACTIVE",
    currency: "EGP",
    fxRateMicro: 1_000_000,
    startDate: null,
    endDate: null,
    progressBp: 5000,
    description: null,
    createdAt: "2026-01-01",
    ...over,
  };
}

function contract(over: Partial<Contract> = {}): Contract {
  return {
    id: 1,
    projectId: 1,
    number: "C-001",
    title: null,
    valueMinor: 100_000_000,
    vatBp: 0,
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

function cert(over: Partial<PaymentCertificate> = {}): PaymentCertificate {
  return {
    id: 1,
    contractId: 1,
    seq: 1,
    number: "PC-1",
    date: "2026-02-01",
    submissionDate: "2026-02-01",
    dueDateOverride: null,
    description: null,
    grossMinor: 50_000_000,
    discountMinor: 0,
    manualAdvanceRecoveryMinor: null,
    status: "APPROVED",
    deletedAt: null,
    createdAt: "2026-02-01",
    ...over,
  };
}

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: 1,
    date: "2026-03-01",
    categoryId: 1,
    description: "Salaries",
    projectId: 1,
    supplier: null,
    amountMinor: 10_000_000, // 100,000.00 EGP
    currency: "EGP",
    fxRateMicro: 1_000_000,
    attachmentPath: null,
    createdAt: "2026-03-01",
    ...over,
  };
}

function stateOf(c: Contract, certs: PaymentCertificate[]) {
  return computeContractState({ contract: c, certificates: certs, payments: [], allocations: [], todayIso: TODAY });
}

describe("project financials with FX consolidation", () => {
  it("consolidates a USD project into EGP at the stored rate", () => {
    const p = project({ currency: "USD", fxRateMicro: 48_000_000 }); // 48 EGP/USD
    const c = contract({ valueMinor: 10_000_000 }); // 100,000 USD
    const certs = [cert({ grossMinor: 5_000_000 })]; // 50,000 USD certified
    const fin = computeProjectFinancials(p, [stateOf(c, certs)], []);
    expect(fin.contractValueEgp).toBe(480_000_000); // 4,800,000.00 EGP in piasters
    expect(fin.revenueEgp).toBe(240_000_000);
    expect(fin.certifiedRatioBp).toBe(5000);
  });

  it("profit = revenue − direct expenses; margin in bp", () => {
    const p = project();
    const c = contract();
    const certs = [cert({ grossMinor: 50_000_000 })]; // 500,000 EGP revenue
    const fin = computeProjectFinancials(p, [stateOf(c, certs)], [
      expense({ amountMinor: 10_000_000 }),
      expense({ id: 2, amountMinor: 5_000_000 }),
    ]);
    expect(fin.expensesEgp).toBe(15_000_000);
    expect(fin.profitEgp).toBe(35_000_000);
    expect(fin.marginBp).toBe(7000); // 70%
  });

  it("expenses in a foreign currency convert at their own stored rate", () => {
    const p = project();
    const fin = computeProjectFinancials(p, [stateOf(contract(), [cert()])], [
      expense({ currency: "USD", fxRateMicro: 50_000_000, amountMinor: 100_000 }), // 1,000 USD → 50,000 EGP
    ]);
    expect(fin.expensesEgp).toBe(5_000_000); // 50,000.00 EGP in piasters
  });

  it("zero revenue yields zero margin (no division blow-up)", () => {
    const p = project();
    const fin = computeProjectFinancials(p, [stateOf(contract(), [])], [expense()]);
    expect(fin.revenueEgp).toBe(0);
    expect(fin.marginBp).toBe(0);
    expect(fin.profitEgp).toBe(-10_000_000);
  });

  it("keeps project cash categories distinct", () => {
    const p = project();
    const c = contract({ advanceMinor: 0, vatBp: 0, retentionBp: 0 });
    const certificate = cert({ grossMinor: 50_000_000 });
    const state = computeContractState({
      contract: c,
      certificates: [certificate],
      payments: [{ id: 1, contractId: 1, kind: "CERTIFICATE", number: "P-1", date: "2026-03-01",
        amountMinor: 30_000_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null,
        deletedAt: null, createdAt: "2026-03-01" }],
      allocations: [{ id: 1, paymentId: 1, certificateId: 1, amountMinor: 20_000_000 }],
      todayIso: TODAY,
    });
    const fin = computeProjectFinancials(p, [state], []);
    expect(fin.certificateCollectionsMinor).toBe(20_000_000);
    expect(fin.unallocatedCustomerCreditMinor).toBe(10_000_000);
    expect(fin.totalActualCashInMinor).toBe(30_000_000);
    expect(fin.outstandingReceivablesMinor).toBe(30_000_000);
  });

  it("sums uncertified value per contract without netting over-certification", () => {
    const overCertified = stateOf(contract({ id: 1, valueMinor: 100_000_000 }), [
      cert({ id: 1, contractId: 1, grossMinor: 120_000_000 }),
    ]);
    const underCertified = stateOf(contract({ id: 2, valueMinor: 100_000_000 }), [
      cert({ id: 2, contractId: 2, grossMinor: 20_000_000 }),
    ]);
    const fin = computeProjectFinancials(project(), [overCertified, underCertified], []);
    expect(overCertified.remainingUncertifiedMinor).toBe(0);
    expect(underCertified.remainingUncertifiedMinor).toBe(80_000_000);
    expect(fin.remainingUncertifiedMinor).toBe(80_000_000);
  });
});

describe("client rollup", () => {
  it("aggregates only the client's own projects", () => {
    const mine = computeProjectFinancials(project({ id: 1, clientId: 7 }), [stateOf(contract(), [cert()])], []);
    const other = computeProjectFinancials(project({ id: 2, clientId: 8 }), [stateOf(contract({ id: 2 }), [cert({ id: 2 })])], []);
    const rollup = computeClientFinancials(7, [mine, other]);
    expect(rollup.projectCount).toBe(1);
    expect(rollup.contractValueEgp).toBe(100_000_000);
  });
});

describe("dashboard KPIs", () => {
  it("uses ALL expenses (incl. overhead) for net profit", () => {
    const fin = computeProjectFinancials(project(), [stateOf(contract(), [cert()])], [expense()]);
    const kpis = computeDashboardKpis(
      [fin],
      [expense(), expense({ id: 2, projectId: null, amountMinor: 2_000_000 })], // overhead too
    );
    expect(kpis.revenueEgp).toBe(50_000_000);
    expect(kpis.expensesEgp).toBe(12_000_000);
    expect(kpis.profitEgp).toBe(38_000_000);
    expect(kpis.marginBp).toBe(7600);
    expect(kpis.activeProjects).toBe(1);
  });
});

describe("freelancer/employee assignment accounts", () => {
  it("computes paid and remaining from payment records", () => {
    const account = computeAssignmentAccount(
      {
        id: 1, personId: 1, projectId: 1, agreedMinor: 5_000_000,
        currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null, createdAt: "2026-01-01",
      },
      [
        { id: 1, assignmentId: 1, date: "2026-02-01", amountMinor: 1_500_000, note: null, createdAt: "" },
        { id: 2, assignmentId: 1, date: "2026-03-01", amountMinor: 1_000_000, note: null, createdAt: "" },
        { id: 3, assignmentId: 99, date: "2026-03-01", amountMinor: 9_999_999, note: null, createdAt: "" }, // other assignment
      ],
    );
    expect(account.paidMinor).toBe(2_500_000);
    expect(account.remainingMinor).toBe(2_500_000);
    expect(account.paidRatioBp).toBe(5000);
  });
});

describe("payment allocation suggestion (oldest first)", () => {
  it("fills certificates in order and reports the remainder", () => {
    const result = suggestAllocation(70, [
      { certificateId: 1, unpaidMinor: 30 },
      { certificateId: 2, unpaidMinor: 30 },
      { certificateId: 3, unpaidMinor: 30 },
    ]);
    expect(result.allocations).toEqual([
      { certificateId: 1, amountMinor: 30 },
      { certificateId: 2, amountMinor: 30 },
      { certificateId: 3, amountMinor: 10 },
    ]);
    expect(result.unallocatedMinor).toBe(0);
  });

  it("reports unallocated overpayment", () => {
    const result = suggestAllocation(100, [{ certificateId: 1, unpaidMinor: 30 }]);
    expect(result.unallocatedMinor).toBe(70);
  });

  it("skips settled certificates", () => {
    const result = suggestAllocation(10, [
      { certificateId: 1, unpaidMinor: 0 },
      { certificateId: 2, unpaidMinor: 5 },
    ]);
    expect(result.allocations).toEqual([{ certificateId: 2, amountMinor: 5 }]);
    expect(result.unallocatedMinor).toBe(5);
  });
});
