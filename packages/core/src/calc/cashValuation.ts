import type { Payment, PaymentAllocation } from "../domain/types";
import type { CurrencyValuation } from "../money/currencyValuation";
import type { ProjectCashValuationReporting } from "./aggregate";

/**
 * Value one project's incoming cash in the caller's valuation currency, split
 * into the four components the dashboard reports beside the headline total.
 *
 * The split has to be exact. The dashboard shows the total and its parts side
 * by side, so a shortfall or an overlap is visible as money that appeared or
 * vanished between them, and `dashboardCashInComponentsReconcile` asserts it.
 * Two rules make it hold:
 *
 *  1. Every figure is valued at the FX effective when the cash ARRIVED — the
 *     payment's rate. Certificate collections are cash too: the part of a
 *     receipt that settled a certificate. Valuing them at the certificate's own
 *     snapshot rate mixes a receivable-measurement rate into a cash
 *     measurement, and the parts then stop adding up to the total whenever a
 *     certificate is paid under a later contract revision.
 *  2. The unallocated remainder is DERIVED as `payment − collected`, never
 *     converted independently. Converting both halves separately rounds each
 *     one, and two roundings do not have to add back to the receipt.
 *
 * This lives in core because both apps need it and neither can be allowed to
 * drift: the desktop read model and the mobile workspace previously differed,
 * and the mobile side fell back to valuing cash components at the project rate
 * while the total came from somewhere else — so its dashboard could report
 * parts that did not sum to its own headline.
 */
export interface PaymentFxResolver {
  (payment: Pick<Payment, "id" | "date" | "contractId">): {
    currency: string;
    fxRateMicro: number;
  };
}

export interface ProjectCashValuationInput {
  /** Live payments belonging to this project's contracts. */
  payments: readonly Payment[];
  /** Allocations of those payments; rows against drafts are ignored. */
  allocations: readonly PaymentAllocation[];
  /** Certificate ids that may hold collections — drafts excluded. */
  billableCertificateIds: ReadonlySet<number>;
  /**
   * FX effective when each payment arrived. Callers without contract-revision
   * history return the project's own currency and rate, which is still
   * internally consistent: every component shares one basis.
   */
  resolveFx: PaymentFxResolver;
}

export function computeProjectCashValuation(
  input: ProjectCashValuationInput,
  valuation: CurrencyValuation,
): ProjectCashValuationReporting {
  const allocatedByPayment = new Map<number, number>();
  for (const allocation of input.allocations) {
    if (!input.billableCertificateIds.has(allocation.certificateId)) continue;
    allocatedByPayment.set(
      allocation.paymentId,
      (allocatedByPayment.get(allocation.paymentId) ?? 0) + allocation.amountMinor,
    );
  }

  const result: ProjectCashValuationReporting = {
    certificateCollectionsReporting: 0,
    advanceReceivedReporting: 0,
    retentionReleasedReporting: 0,
    totalActualCashInReporting: 0,
    unallocatedCustomerCreditReporting: 0,
  };

  for (const payment of input.payments) {
    const fx = input.resolveFx(payment);
    const paymentReporting = valuation.value(payment.amountMinor, fx.currency, fx.fxRateMicro);
    result.totalActualCashInReporting += paymentReporting;
    if (payment.kind === "ADVANCE") {
      result.advanceReceivedReporting += paymentReporting;
    } else if (payment.kind === "RETENTION_RELEASE") {
      result.retentionReleasedReporting += paymentReporting;
    } else {
      // Clamped: an allocation total above the receipt would otherwise make the
      // derived remainder negative and overstate collections.
      const allocatedMinor = Math.min(
        payment.amountMinor,
        Math.max(0, allocatedByPayment.get(payment.id) ?? 0),
      );
      const collectedReporting = valuation.value(allocatedMinor, fx.currency, fx.fxRateMicro);
      result.certificateCollectionsReporting += collectedReporting;
      result.unallocatedCustomerCreditReporting += paymentReporting - collectedReporting;
    }
  }

  return result;
}
