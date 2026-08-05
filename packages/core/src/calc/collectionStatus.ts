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
  certifiedBaseMinor: number,
): CertificateStatus {
  if (currentStatus === "DRAFT" || currentStatus === "SUBMITTED") return currentStatus;
  if (isFullyCollected(netPayableMinor, validAllocatedMinor, certifiedBaseMinor)) return "PAID";
  return currentStatus === "PAID" ? "APPROVED" : currentStatus;
}

/**
 * Whether there is nothing left for the client to pay on this certificate.
 *
 * The obvious half is `allocated >= netPayable`. The subtle half is what a net
 * payable of zero means, and it depends on whether anything was certified:
 *
 *  - Base zero. Nothing has been claimed — an empty or placeholder
 *    certificate. There is nothing to settle, so it is left where it is rather
 *    than being announced as collected.
 *  - Base positive, net payable zero. Real certified work whose payable has
 *    been fully consumed by advance recovery, retention and withholding. The
 *    client owes nothing and never will; the claim is closed. This is ordinary
 *    on a contract with a large or full advance, where every certificate can
 *    net to zero. Requiring `netPayable > 0` to settle left those permanently
 *    APPROVED — reported as an open claim for money nobody would ever pay, and
 *    re-examined by every reconciliation pass.
 *
 * A negative net payable (retention plus withholding exceeding base plus VAT)
 * is treated the same as zero: nothing is collectible from the client.
 */
function isFullyCollected(
  netPayableMinor: number,
  validAllocatedMinor: number,
  certifiedBaseMinor: number,
): boolean {
  if (netPayableMinor > 0) return validAllocatedMinor >= netPayableMinor;
  return certifiedBaseMinor > 0;
}
