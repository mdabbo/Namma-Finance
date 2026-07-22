import type { CertificateStatus } from "../domain/types";

/**
 * Derive collection status exclusively from valid payment allocations.
 * Drafts remain drafts; PAID is never accepted as an unsupported assertion.
 */
export function desiredCertificateStatus(
  currentStatus: CertificateStatus,
  netPayableMinor: number,
  validAllocatedMinor: number,
): CertificateStatus {
  if (currentStatus === "DRAFT") return "DRAFT";
  const fullyCollected = netPayableMinor > 0 && validAllocatedMinor >= netPayableMinor;
  if (fullyCollected) return "PAID";
  return currentStatus === "PAID" ? "APPROVED" : currentStatus;
}
