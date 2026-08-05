import { describe, expect, it } from "vitest";
import {
  computeProjectCashValuation,
  dashboardCashInComponentsReconcile,
  type Payment,
  type PaymentAllocation,
} from "../src";

/**
 * The dashboard shows total cash in beside the four components that make it up,
 * so a shortfall or an overlap between them is visible as money that appeared
 * or vanished. `computeProjectFinancials` used to accept an OPTIONAL valuation
 * and, without one, mixed measurement bases: certificate collections at each
 * certificate's FX snapshot, every other component at the project rate. The
 * mobile workspace took that path in production, so its parts could not add up
 * to its own headline. The valuation is now required and built here.
 */

const payment = (over: Partial<Payment> & Pick<Payment, "id" | "kind" | "amountMinor">): Payment => ({
  contractId: 1,
  number: `P-${over.id}`,
  date: "2026-03-01",
  method: "BANK_TRANSFER",
  bank: null,
  reference: null,
  notes: null,
  deletedAt: null,
  createdAt: "2026-03-01",
  ...over,
});

const allocation = (id: number, paymentId: number, certificateId: number, amountMinor: number): PaymentAllocation =>
  ({ id, paymentId, certificateId, amountMinor });

const atRate = (currency: string, fxRateMicro: number) => () => ({ currency, fxRateMicro });

describe("project cash valuation", () => {
  it("partitions every receipt into exactly one component", () => {
    const valuation = computeProjectCashValuation({
      payments: [
        payment({ id: 1, kind: "CERTIFICATE", amountMinor: 100_000 }),
        payment({ id: 2, kind: "ADVANCE", amountMinor: 30_000 }),
        payment({ id: 3, kind: "RETENTION_RELEASE", amountMinor: 5_000 }),
      ],
      allocations: [allocation(1, 1, 10, 60_000)],
      billableCertificateIds: new Set([10]),
      resolveFx: atRate("EGP", 1_000_000),
    });

    expect(valuation.certificateCollectionsEgp).toBe(60_000);
    expect(valuation.unallocatedCustomerCreditEgp).toBe(40_000);
    expect(valuation.advanceReceivedEgp).toBe(30_000);
    expect(valuation.retentionReleasedEgp).toBe(5_000);
    expect(valuation.totalActualCashInEgp).toBe(135_000);
    expect(
      valuation.certificateCollectionsEgp
      + valuation.unallocatedCustomerCreditEgp
      + valuation.advanceReceivedEgp
      + valuation.retentionReleasedEgp,
    ).toBe(valuation.totalActualCashInEgp);
  });

  it("ignores allocations against draft certificates", () => {
    const valuation = computeProjectCashValuation({
      payments: [payment({ id: 1, kind: "CERTIFICATE", amountMinor: 100_000 })],
      allocations: [allocation(1, 1, 10, 60_000), allocation(2, 1, 99, 25_000)],
      billableCertificateIds: new Set([10]),
      resolveFx: atRate("EGP", 1_000_000),
    });
    expect(valuation.certificateCollectionsEgp).toBe(60_000);
    // The draft's 25 000 stays customer credit rather than becoming a collection.
    expect(valuation.unallocatedCustomerCreditEgp).toBe(40_000);
  });

  /**
   * The remainder is derived from the receipt, never converted on its own.
   * Converting both halves independently rounds each, and two roundings need
   * not add back — which is exactly how the components used to drift apart.
   */
  it("keeps the parts adding back to the receipt under a lossy FX rate", () => {
    const valuation = computeProjectCashValuation({
      payments: [payment({ id: 1, kind: "CERTIFICATE", amountMinor: 33_333 })],
      allocations: [allocation(1, 1, 10, 11_111)],
      billableCertificateIds: new Set([10]),
      // A rate chosen so neither half converts to a whole piaster cleanly.
      resolveFx: atRate("USD", 47_333_333),
    });
    expect(
      valuation.certificateCollectionsEgp + valuation.unallocatedCustomerCreditEgp,
    ).toBe(valuation.totalActualCashInEgp);
  });

  it("clamps an over-allocated receipt instead of reporting negative credit", () => {
    const valuation = computeProjectCashValuation({
      payments: [payment({ id: 1, kind: "CERTIFICATE", amountMinor: 50_000 })],
      allocations: [allocation(1, 1, 10, 80_000)],
      billableCertificateIds: new Set([10]),
      resolveFx: atRate("EGP", 1_000_000),
    });
    expect(valuation.certificateCollectionsEgp).toBe(50_000);
    expect(valuation.unallocatedCustomerCreditEgp).toBe(0);
    expect(valuation.totalActualCashInEgp).toBe(50_000);
  });

  it("satisfies the dashboard reconciliation the components are shown under", () => {
    const valuation = computeProjectCashValuation({
      payments: [
        payment({ id: 1, kind: "CERTIFICATE", amountMinor: 77_777 }),
        payment({ id: 2, kind: "ADVANCE", amountMinor: 12_345 }),
      ],
      allocations: [allocation(1, 1, 10, 55_555)],
      billableCertificateIds: new Set([10]),
      resolveFx: atRate("USD", 48_000_000),
    });
    expect(
      dashboardCashInComponentsReconcile({
        contractValueEgp: 0,
        outstandingReceivablesEgp: 0,
        cashOutEgp: 0,
        netCashPositionEgp: 0,
        certificateCollectionsEgp: valuation.certificateCollectionsEgp,
        advanceReceivedEgp: valuation.advanceReceivedEgp,
        retentionReleasedEgp: valuation.retentionReleasedEgp,
        unallocatedCustomerCreditEgp: valuation.unallocatedCustomerCreditEgp,
        // DashboardOverview names this totalCashInEgp; the valuation calls the
        // same figure totalActualCashInEgp.
        totalCashInEgp: valuation.totalActualCashInEgp,
      }),
    ).toBe(true);
  });
});
