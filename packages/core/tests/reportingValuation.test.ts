import { describe, expect, it } from "vitest";
import type { Contract, Expense, Payment, PaymentCertificate, Project } from "../src/domain/types";
import { computeContractState } from "../src/calc/contract";
import { computeDashboardKpis, computeProjectFinancials } from "../src/calc/aggregate";
import { computeProjectCashValuation } from "../src/calc/cashValuation";
import {
  computeDashboardOverview,
  dashboardCashInComponentsReconcile,
  selectOpenReceivables,
} from "../src/calc/dashboard";
import { fromEgpPiasters, toEgpPiasters } from "../src/money/money";
import { EGP_VALUATION, reportingValuation } from "../src/money/currencyValuation";

/**
 * Reporting-currency valuation.
 *
 * The defect these tests pin down was reported from a real workspace: a single
 * SAR 325,000 contract, viewed with SAR as the reporting currency, read
 * SAR 317,031.19 on the dashboard while the contract page said 325,000. The
 * consolidated figure had been converted SAR -> EGP at the rate stored on the
 * project and back EGP -> SAR at today's rate. It was fixed once in the view
 * (July 2026) and came back unnoticed when the dashboard maths moved into this
 * package, because nothing here asserted it.
 */

// A SAR project created when 1 SAR bought 12.681248 EGP; today it buys 13.
const SAR_AT_SIGNING = 12_681_248;
const SAR_TODAY = 13_000_000;
const USD_AT_SIGNING = 48_000_000;
const SAR = reportingValuation("SAR", SAR_TODAY);

const TODAY = "2026-07-15";

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, code: "PRJ-2026-002", name: "CASA", clientId: 1, country: "Saudi Arabia", city: "Riyadh",
    manager: null, discipline: "HVAC", projectType: null, status: "ACTIVE",
    currency: "SAR", fxRateMicro: SAR_AT_SIGNING,
    startDate: null, endDate: null, progressBp: 0, description: null, createdAt: "2026-01-01",
    ...over,
  };
}

function contract(over: Partial<Contract> = {}): Contract {
  return {
    id: 1, projectId: 1, number: "CON-2026-0001", title: null,
    valueMinor: 32_500_000, // SAR 325,000.00
    vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0,
    advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null,
    performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
    valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null,
    signedDate: null, notes: null, createdAt: "2026-01-01",
    ...over,
  };
}

function cert(over: Partial<PaymentCertificate> = {}): PaymentCertificate {
  return {
    id: 1, contractId: 1, seq: 1, number: "PC-1", date: "2026-02-01", submissionDate: "2026-02-01",
    dueDateOverride: null, description: null,
    grossMinor: 8_125_000, // SAR 81,250.00 — a 25% milestone
    discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED",
    deletedAt: null, createdAt: "2026-02-01",
    ...over,
  };
}

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: 1, date: "2026-03-01", categoryId: 1, description: "Site visit", projectId: 1, supplier: null,
    amountMinor: 1_000_000, currency: "SAR", fxRateMicro: SAR_AT_SIGNING,
    attachmentPath: null, createdAt: "2026-03-01",
    ...over,
  };
}

const payment = (over: Partial<Payment> & Pick<Payment, "id" | "kind" | "amountMinor">): Payment => ({
  contractId: 1, number: `P-${over.id}`, date: "2026-03-01", method: "BANK_TRANSFER",
  bank: null, reference: null, notes: null, deletedAt: null, createdAt: "2026-03-01",
  ...over,
});

function stateOf(c: Contract, certs: PaymentCertificate[], payments: Payment[] = []) {
  return computeContractState({ contract: c, certificates: certs, payments, allocations: [], todayIso: TODAY });
}

const NO_CASH = {
  certificateCollectionsReporting: 0, advanceReceivedReporting: 0, retentionReleasedReporting: 0,
  totalActualCashInReporting: 0, unallocatedCustomerCreditReporting: 0,
};

describe("valuation primitives", () => {
  it("the EGP valuation is the pivot itself", () => {
    expect(EGP_VALUATION.currency).toBe("EGP");
    expect(EGP_VALUATION.value(10_000, "USD", USD_AT_SIGNING)).toBe(toEgpPiasters(10_000, "USD", USD_AT_SIGNING));
    expect(reportingValuation("EGP", 1_000_000)).toBe(EGP_VALUATION);
  });

  it("takes an amount already in the reporting currency at face value, whatever its stored rate", () => {
    for (const storedRate of [1, SAR_AT_SIGNING, SAR_TODAY, 99_000_000]) {
      expect(SAR.value(32_500_000, "SAR", storedRate)).toBe(32_500_000);
    }
    expect(SAR.value(-1_234, "SAR", SAR_AT_SIGNING)).toBe(-1_234);
  });

  it("values a foreign amount through the pivot: its own rate in, the reporting rate out", () => {
    const usd = 1_000_000; // USD 10,000.00
    expect(SAR.value(usd, "USD", USD_AT_SIGNING))
      .toBe(fromEgpPiasters(toEgpPiasters(usd, "USD", USD_AT_SIGNING), "SAR", SAR_TODAY));
    // EGP is foreign to a SAR report too.
    expect(SAR.value(13_000_000, "EGP", 1_000_000)).toBe(1_000_000);
  });

  it("rejects a corrupt stored rate in every reporting currency, not only where it is used", () => {
    // Face value needs no rate, but a record that fails in an EGP report must
    // not pass quietly in a SAR one.
    expect(() => SAR.value(100, "SAR", 0)).toThrow(RangeError);
    expect(() => EGP_VALUATION.value(100, "SAR", 0)).toThrow(RangeError);
    expect(() => SAR.value(1.5, "SAR", SAR_AT_SIGNING)).toThrow(RangeError);
    expect(() => reportingValuation("SAR", 0)).toThrow(RangeError);
  });
});

describe("the reported defect: a SAR contract on a SAR dashboard", () => {
  it("documents what the EGP round trip used to show", () => {
    // The old path: value in EGP at the project's stored rate, then convert the
    // total to SAR at today's rate. Kept as an executable record of the size of
    // the error — 2.45% on these rates, on a contract whose value never moved.
    const fin = computeProjectFinancials(project(), [stateOf(contract(), [cert()])], [], NO_CASH, EGP_VALUATION);
    const overview = computeDashboardOverview([fin], [], EGP_VALUATION);
    expect(fromEgpPiasters(overview.contractValueReporting, "SAR", SAR_TODAY)).toBe(31_703_120); // SAR 317,031.20
    expect(fromEgpPiasters(overview.outstandingReceivablesReporting, "SAR", SAR_TODAY)).toBe(7_925_780); // SAR 79,257.80
  });

  it("reads the contract and its receivable at face value", () => {
    const fin = computeProjectFinancials(project(), [stateOf(contract(), [cert()])], [], NO_CASH, SAR);
    const overview = computeDashboardOverview([fin], [], SAR);
    expect(overview.contractValueReporting).toBe(32_500_000); // SAR 325,000.00
    expect(overview.outstandingReceivablesReporting).toBe(8_125_000); // SAR 81,250.00
    expect(fin.revenueReporting).toBe(8_125_000);
    // The consolidated figures now agree with the per-project ones the
    // contract page shows.
    expect(overview.contractValueReporting).toBe(fin.contractValueMinor);
    expect(overview.outstandingReceivablesReporting).toBe(fin.outstandingReceivablesMinor);
  });

  it("does not move when today's rate moves", () => {
    const values = [9_000_000, SAR_TODAY, 17_500_000].map((rateToday) => {
      const valuation = reportingValuation("SAR", rateToday);
      const fin = computeProjectFinancials(project(), [stateOf(contract(), [cert()])], [expense()], NO_CASH, valuation);
      const overview = computeDashboardOverview([fin], [expense()], valuation);
      return [overview.contractValueReporting, overview.outstandingReceivablesReporting, overview.cashOutReporting, fin.profitReporting];
    });
    expect(values[1]).toEqual(values[0]);
    expect(values[2]).toEqual(values[0]);
    expect(values[0]).toEqual([32_500_000, 8_125_000, 1_000_000, 7_125_000]);
  });

  it("keeps face value when a certificate carries a later revision's rate snapshot", () => {
    const revised = cert({ currencySnapshot: "SAR", fxRateMicroSnapshot: 13_400_000 });
    const fin = computeProjectFinancials(project(), [stateOf(contract(), [revised])], [], NO_CASH, SAR);
    expect(fin.revenueReporting).toBe(8_125_000);
    expect(fin.outstandingReporting).toBe(8_125_000);
    const [row] = selectOpenReceivables(
      [{ state: stateOf(contract(), [revised]), projectCurrency: "SAR", projectFxRateMicro: SAR_AT_SIGNING }],
      SAR,
    );
    expect(row?.unpaidReporting).toBe(row?.unpaidMinor);
  });
});

describe("cash in the reporting currency", () => {
  it("values receipts at face value and keeps the four components summing to the total", () => {
    const cash = computeProjectCashValuation({
      payments: [
        payment({ id: 1, kind: "CERTIFICATE", amountMinor: 8_125_000 }),
        payment({ id: 2, kind: "ADVANCE", amountMinor: 3_250_000 }),
        payment({ id: 3, kind: "RETENTION_RELEASE", amountMinor: 405_133 }),
      ],
      allocations: [{ id: 1, paymentId: 1, certificateId: 10, amountMinor: 5_000_001 }],
      billableCertificateIds: new Set([10]),
      // A later contract revision moved the rate; the receipts are still SAR.
      resolveFx: () => ({ currency: "SAR", fxRateMicro: 13_333_333 }),
    }, SAR);

    expect(cash.totalActualCashInReporting).toBe(8_125_000 + 3_250_000 + 405_133);
    expect(cash.certificateCollectionsReporting).toBe(5_000_001);
    expect(cash.unallocatedCustomerCreditReporting).toBe(8_125_000 - 5_000_001);
    expect(
      cash.certificateCollectionsReporting + cash.unallocatedCustomerCreditReporting
      + cash.advanceReceivedReporting + cash.retentionReleasedReporting,
    ).toBe(cash.totalActualCashInReporting);
  });

  it("still partitions exactly when the receipts are foreign and rounding is involved", () => {
    // USD receipts on a SAR report: every figure is rounded to a halala. The
    // remainder is derived, never converted on its own, so the parts cannot
    // drift from the total.
    const cash = computeProjectCashValuation({
      payments: [
        payment({ id: 1, kind: "CERTIFICATE", amountMinor: 333_333 }),
        payment({ id: 2, kind: "CERTIFICATE", amountMinor: 100_001 }),
        payment({ id: 3, kind: "ADVANCE", amountMinor: 77_777 }),
      ],
      allocations: [
        { id: 1, paymentId: 1, certificateId: 10, amountMinor: 111_111 },
        { id: 2, paymentId: 2, certificateId: 10, amountMinor: 33_333 },
      ],
      billableCertificateIds: new Set([10]),
      resolveFx: () => ({ currency: "USD", fxRateMicro: 48_253_117 }),
    }, SAR);
    const fin = computeProjectFinancials(
      project({ currency: "USD", fxRateMicro: 48_253_117 }), [stateOf(contract(), [])], [], cash, SAR,
    );
    expect(dashboardCashInComponentsReconcile(computeDashboardOverview([fin], [], SAR))).toBe(true);
  });
});

describe("a mixed portfolio on a SAR report", () => {
  const sarProject = project();
  const usdProject = project({ id: 2, code: "PRJ-2026-003", currency: "USD", fxRateMicro: USD_AT_SIGNING });
  const usdContract = contract({ id: 2, projectId: 2, valueMinor: 10_000_000 }); // USD 100,000.00
  const usdCert = cert({ id: 2, contractId: 2, grossMinor: 2_000_000 }); // USD 20,000.00
  const egpOverhead = expense({ id: 9, projectId: null, amountMinor: 26_000_000, currency: "EGP", fxRateMicro: 1_000_000 });

  const build = () => {
    const projects = [
      computeProjectFinancials(sarProject, [stateOf(contract(), [cert()])], [expense()], NO_CASH, SAR),
      computeProjectFinancials(usdProject, [stateOf(usdContract, [usdCert])], [], NO_CASH, SAR),
    ];
    return { projects, expenses: [expense(), egpOverhead] };
  };

  it("adds SAR at face value to foreign amounts valued through the pivot", () => {
    const { projects, expenses } = build();
    const overview = computeDashboardOverview(projects, expenses, SAR);
    const usdToSar = (minor: number) => fromEgpPiasters(toEgpPiasters(minor, "USD", USD_AT_SIGNING), "SAR", SAR_TODAY);

    expect(overview.contractValueReporting).toBe(32_500_000 + usdToSar(10_000_000));
    expect(overview.outstandingReceivablesReporting).toBe(8_125_000 + usdToSar(2_000_000));
    // SAR expense at face value + EGP 260,000.00 at today's SAR rate.
    expect(overview.cashOutReporting).toBe(1_000_000 + 2_000_000);
  });

  it("holds profit = revenue - expenses in the reporting currency", () => {
    const { projects, expenses } = build();
    const kpis = computeDashboardKpis(projects, expenses, SAR);
    expect(kpis.profitReporting).toBe(kpis.revenueReporting - kpis.expensesReporting);
    for (const fin of projects) expect(fin.profitReporting).toBe(fin.revenueReporting - fin.expensesReporting);
  });

  it("leaves an EGP report exactly as it was", () => {
    const projects = [
      computeProjectFinancials(sarProject, [stateOf(contract(), [cert()])], [expense()], NO_CASH, EGP_VALUATION),
      computeProjectFinancials(usdProject, [stateOf(usdContract, [usdCert])], [], NO_CASH, EGP_VALUATION),
    ];
    const overview = computeDashboardOverview(projects, [expense(), egpOverhead], EGP_VALUATION);
    expect(overview.contractValueReporting).toBe(
      toEgpPiasters(32_500_000, "SAR", SAR_AT_SIGNING) + toEgpPiasters(10_000_000, "USD", USD_AT_SIGNING),
    );
    expect(overview.cashOutReporting).toBe(toEgpPiasters(1_000_000, "SAR", SAR_AT_SIGNING) + 26_000_000);
  });
});
