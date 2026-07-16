import { assertMinor } from "../money/money";

export interface OpenCertificateBalance {
  certificateId: number;
  unpaidMinor: number;
}

export interface SuggestedAllocation {
  certificateId: number;
  amountMinor: number;
}

/**
 * Suggest how an incoming payment should be split across open certificates:
 * oldest first (the order of `openBalances`), each filled up to its unpaid
 * balance. Returns the split plus any un-allocatable remainder (payment
 * larger than everything owed).
 */
export function suggestAllocation(
  paymentMinor: number,
  openBalances: OpenCertificateBalance[],
): { allocations: SuggestedAllocation[]; unallocatedMinor: number } {
  assertMinor(paymentMinor, "payment");
  if (paymentMinor < 0) throw new RangeError("payment must be >= 0");
  let remaining = paymentMinor;
  const allocations: SuggestedAllocation[] = [];
  for (const open of openBalances) {
    if (remaining === 0) break;
    const amount = Math.min(remaining, Math.max(0, open.unpaidMinor));
    if (amount > 0) {
      allocations.push({ certificateId: open.certificateId, amountMinor: amount });
      remaining -= amount;
    }
  }
  return { allocations, unallocatedMinor: remaining };
}
