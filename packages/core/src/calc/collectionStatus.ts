import type { CertificateStatus } from "../domain/types";

/**
 * Derive collection status exclusively from valid payment allocations.
 *
 * Collection evidence settles an *approved* claim; it never advances the
 * approval workflow. A submitted certificate the client happens to have paid
 * stays SUBMITTED until someone approves it, so cash can never substitute for
 * the approval step. Drafts are untouchable, and PAID is only ever the
 * consequence of allocations that cover net payable — never an assertion.
 *
 * This rule is the single source shared by the Rust payment transaction and
 * the TypeScript read model; `tests/collectionStatus.test.ts` and the Rust
 * `certificate_status_fixtures` suite assert the same table.
 */
export function desiredCertificateStatus(
  currentStatus: CertificateStatus,
  netPayableMinor: number,
  validAllocatedMinor: number,
): CertificateStatus {
  if (currentStatus === "DRAFT" || currentStatus === "SUBMITTED") return currentStatus;
  const fullyCollected = netPayableMinor > 0 && validAllocatedMinor >= netPayableMinor;
  if (fullyCollected) return "PAID";
  return currentStatus === "PAID" ? "APPROVED" : currentStatus;
}
