import type { PaymentCertificate } from "../domain/types";

/** Add days to an ISO date string (UTC-safe, no DST drift). */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || d === undefined) throw new RangeError(`invalid ISO date: ${isoDate}`);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/**
 * Due date rule (confirmed): submission date + the contract's payment terms,
 * unless a manual override is set on the certificate. Certificates that were
 * never submitted have no due date.
 */
export function certificateDueDate(
  cert: Pick<PaymentCertificate, "submissionDate" | "dueDateOverride">,
  paymentTermsDays: number,
): string | null {
  if (cert.dueDateOverride) return cert.dueDateOverride;
  if (!cert.submissionDate) return null;
  return addDaysIso(cert.submissionDate, paymentTermsDays);
}

/** Overdue = billable, not fully paid, and past its due date. */
export function isCertificateOverdue(
  cert: Pick<PaymentCertificate, "submissionDate" | "dueDateOverride" | "status">,
  paymentTermsDays: number,
  unpaidBalanceMinor: number,
  todayIso: string,
): boolean {
  if (cert.status === "DRAFT" || cert.status === "PAID") return false;
  if (unpaidBalanceMinor <= 0) return false;
  const due = certificateDueDate(cert, paymentTermsDays);
  if (!due) return false;
  return todayIso > due;
}
