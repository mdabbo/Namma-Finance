/**
 * The exchange rate an accepted claim's expense is recorded at, chosen the way
 * the expense form chooses it: the project's own rate when the claim is in that
 * project's currency, otherwise the office rate in Settings → Currencies. EGP is
 * always 1. No rate (a currency with none set) means the claim cannot be
 * accepted yet, rather than being accepted at a guessed rate.
 */

export interface ClaimRate {
  fxRateMicro: number;
  source: "egp" | "project" | "settings";
}

export function claimRate(
  currency: string,
  project: { currency: string; fxRateMicro: number } | null,
  rates: { code: string; fxRateMicro: number }[],
): ClaimRate | null {
  if (currency === "EGP") return { fxRateMicro: 1_000_000, source: "egp" };
  if (project && project.currency === currency && project.fxRateMicro > 0) {
    return { fxRateMicro: project.fxRateMicro, source: "project" };
  }
  const office = rates.find((r) => r.code === currency);
  if (office && office.fxRateMicro > 0) return { fxRateMicro: office.fxRateMicro, source: "settings" };
  return null;
}

/** 12850000 → "12.85". */
export function formatRateMicro(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
