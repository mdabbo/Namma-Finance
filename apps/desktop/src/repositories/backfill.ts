import type { QueryClient } from "@tanstack/react-query";
import { allocateUnallocatedPayments, backPaidCertificatesWithPayments } from "./payments";
import { reconcileMilestoneCertificates } from "./milestoneCertificates";

/**
 * Startup reconciliation, in dependency order:
 *  1. allocate any unallocated payment money to open certificates (heals
 *     "outstanding receivables" / "remaining balance" for old data),
 *  2. back under-collected PAID certificates with payments,
 *  3. prepare draft certificates for achieved milestones.
 * All steps are idempotent. Retries — the first run races app startup.
 */
export async function runPaidBackfill(queryClient: QueryClient): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const healed = await allocateUnallocatedPayments();
      const backed = await backPaidCertificatesWithPayments();
      const drafted = await reconcileMilestoneCertificates();
      if (healed + backed + drafted > 0) {
        console.log(`[reconcile] allocations=${healed} backing-payments=${backed} draft-certificates=${drafted}`);
        await queryClient.invalidateQueries();
      }
      return;
    } catch (err) {
      console.error(`[reconcile] attempt ${attempt} failed`, err);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}
