import { select } from "../lib/db";

export interface SuspectedSyntheticPayment {
  paymentId: number;
  paymentNumber: string;
  paymentDate: string;
  amountMinor: number;
  certificateId: number;
  certificateNumber: string;
  projectName: string;
  currency: string;
}

export interface LegacyDuplicateAllocation {
  allocationId: number;
  paymentNumber: string;
  certificateNumber: string;
  amountMinor: number;
  projectName: string;
  currency: string;
}

/** Preserved schema-10 duplicates that require explicit user review. */
export function listLegacyDuplicateAllocations(): Promise<LegacyDuplicateAllocation[]> {
  return select<LegacyDuplicateAllocation>(`
    SELECT a.id AS allocationId,pm.number AS paymentNumber,pc.number AS certificateNumber,
           a.amount_minor AS amountMinor,p.name AS projectName,p.currency AS currency
    FROM payment_certificate_allocations a
    JOIN payments pm ON pm.id=a.payment_id
    JOIN payment_certificates pc ON pc.id=a.certificate_id
    JOIN contracts c ON c.id=pm.contract_id JOIN projects p ON p.id=c.project_id
    WHERE a.integrity_exception=1 ORDER BY pm.date DESC,a.id
  `);
}

/** Read-only heuristic for records created by the removed legacy backfill. */
export function listSuspectedSyntheticPayments(): Promise<SuspectedSyntheticPayment[]> {
  return select<SuspectedSyntheticPayment>(`
    SELECT pm.id AS paymentId, pm.number AS paymentNumber, pm.date AS paymentDate,
           pm.amount_minor AS amountMinor, pc.id AS certificateId,
           pc.number AS certificateNumber, p.name AS projectName, p.currency AS currency
    FROM payments pm
    JOIN payment_certificate_allocations a ON a.payment_id = pm.id
    JOIN payment_certificates pc ON pc.id = a.certificate_id
    JOIN contracts ct ON ct.id = pm.contract_id
    JOIN projects p ON p.id = ct.project_id
    WHERE pm.deleted_at IS NULL
      AND pm.kind = 'CERTIFICATE'
      AND pm.method = 'BANK_TRANSFER'
      AND pm.number = 'PAY-' || pc.number
      AND pm.date = substr(pm.created_at, 1, 10)
      AND pm.amount_minor = a.amount_minor
      AND NULLIF(TRIM(COALESCE(pm.bank, '')), '') IS NULL
      AND NULLIF(TRIM(COALESCE(pm.reference, '')), '') IS NULL
      AND NULLIF(TRIM(COALESCE(pm.notes, '')), '') IS NULL
      AND (SELECT COUNT(*) FROM payment_certificate_allocations x WHERE x.payment_id = pm.id) = 1
    ORDER BY pm.date DESC, pm.id DESC
  `);
}
