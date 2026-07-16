import type { Contract, Payment, PaymentAllocation, PaymentCertificate } from "../domain/types";
import { isBillable } from "../domain/types";
import { applyBp, ratioBp } from "../money/money";
import { computeCertificate, type CertificateBreakdown } from "./certificate";
import { certificateDueDate, isCertificateOverdue } from "./overdue";

/** Static figures derived from the contract terms alone. */
export interface ContractFigures {
  vatMinor: number; // VAT on the full contract value
  retentionMinor: number; // total retention if fully certified
  /** value + VAT − retention: what would be paid out over the contract's life. */
  netContractMinor: number;
}

export function deriveContractFigures(
  contract: Pick<Contract, "valueMinor" | "vatBp" | "retentionBp">,
): ContractFigures {
  const vat = applyBp(contract.valueMinor, contract.vatBp);
  const retention = applyBp(contract.valueMinor, contract.retentionBp);
  return {
    vatMinor: vat,
    retentionMinor: retention,
    netContractMinor: contract.valueMinor + vat - retention,
  };
}

export interface CertificateState {
  certificate: PaymentCertificate;
  breakdown: CertificateBreakdown;
  /** Payments allocated to this certificate. */
  paidMinor: number;
  unpaidMinor: number;
  dueDate: string | null;
  overdue: boolean;
}

export interface ContractState {
  contract: Contract;
  figures: ContractFigures;
  certificates: CertificateState[];

  /** Σ base (gross − discount) of billable certificates. */
  certifiedBaseMinor: number;
  /** Contract value not yet certified. */
  remainingUncertifiedMinor: number;
  certifiedRatioBp: number;

  retentionWithheldMinor: number;
  retentionReleasedMinor: number;
  retentionHeldMinor: number;

  advanceMinor: number;
  advanceReceivedMinor: number;
  advanceRecoveredMinor: number;
  advanceRemainingMinor: number;

  /** Σ net payable of billable certificates. */
  totalDueMinor: number;
  /** Payments allocated to certificates. */
  totalPaidMinor: number;
  outstandingMinor: number;
  collectionRatioBp: number;

  /** All cash actually received: advance + certificate payments + released retention. */
  totalCashInMinor: number;
}

export interface ContractStateInput {
  contract: Contract;
  /** All certificates of the contract (deleted ones are ignored). */
  certificates: PaymentCertificate[];
  /** All payments of the contract (deleted ones are ignored). */
  payments: Payment[];
  allocations: PaymentAllocation[];
  todayIso: string;
}

/**
 * Recompute the full financial state of a contract from source records.
 * Advance recovery is threaded through billable certificates in `seq` order,
 * so per-certificate figures are always derived, never stored.
 */
export function computeContractState(input: ContractStateInput): ContractState {
  const { contract, todayIso } = input;
  const figures = deriveContractFigures(contract);

  const certificates = input.certificates
    .filter((c) => c.deletedAt === null)
    .sort((a, b) => a.seq - b.seq || a.id - b.id);
  const payments = input.payments.filter((p) => p.deletedAt === null);
  const livePaymentIds = new Set(payments.map((p) => p.id));
  const allocations = input.allocations.filter((a) => livePaymentIds.has(a.paymentId));

  const paidByCertificate = new Map<number, number>();
  for (const alloc of allocations) {
    paidByCertificate.set(alloc.certificateId, (paidByCertificate.get(alloc.certificateId) ?? 0) + alloc.amountMinor);
  }

  let advanceRecovered = 0;
  let certifiedBase = 0;
  let retentionWithheld = 0;
  let totalDue = 0;
  let totalPaid = 0;

  const certStates: CertificateState[] = certificates.map((cert) => {
    const billable = isBillable(cert.status);
    const breakdown = computeCertificate({
      grossMinor: cert.grossMinor,
      discountMinor: cert.discountMinor,
      vatBp: contract.vatBp,
      retentionBp: contract.retentionBp,
      withholdingBp: contract.withholdingBp,
      advance: {
        method: contract.advanceRecoveryMethod,
        contractValueMinor: contract.valueMinor,
        advanceMinor: contract.advanceMinor,
        recoveredBeforeMinor: advanceRecovered,
        manualRecoveryMinor: cert.manualAdvanceRecoveryMinor,
      },
    });

    const paid = paidByCertificate.get(cert.id) ?? 0;
    if (billable) {
      advanceRecovered += breakdown.advanceRecoveryMinor;
      certifiedBase += breakdown.baseMinor;
      retentionWithheld += breakdown.retentionMinor;
      totalDue += breakdown.netPayableMinor;
      totalPaid += paid;
    }
    const unpaid = Math.max(0, breakdown.netPayableMinor - paid);
    return {
      certificate: cert,
      breakdown,
      paidMinor: paid,
      unpaidMinor: unpaid,
      dueDate: billable ? certificateDueDate(cert, contract.paymentTermsDays) : null,
      overdue: billable && isCertificateOverdue(cert, contract.paymentTermsDays, unpaid, todayIso),
    };
  });

  const retentionReleased = sum(payments.filter((p) => p.kind === "RETENTION_RELEASE").map((p) => p.amountMinor));
  const advanceReceived = sum(payments.filter((p) => p.kind === "ADVANCE").map((p) => p.amountMinor));

  return {
    contract,
    figures,
    certificates: certStates,
    certifiedBaseMinor: certifiedBase,
    remainingUncertifiedMinor: contract.valueMinor - certifiedBase,
    certifiedRatioBp: ratioBp(certifiedBase, contract.valueMinor),
    retentionWithheldMinor: retentionWithheld,
    retentionReleasedMinor: retentionReleased,
    retentionHeldMinor: retentionWithheld - retentionReleased,
    advanceMinor: contract.advanceMinor,
    advanceReceivedMinor: advanceReceived,
    advanceRecoveredMinor: advanceRecovered,
    advanceRemainingMinor: contract.advanceMinor - advanceRecovered,
    totalDueMinor: totalDue,
    totalPaidMinor: totalPaid,
    outstandingMinor: totalDue - totalPaid,
    collectionRatioBp: ratioBp(totalPaid, totalDue),
    totalCashInMinor: advanceReceived + totalPaid + retentionReleased,
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
