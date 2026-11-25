import { mulDivRound, ratioBp } from "../money/money";
import type { ProjectProfitability } from "./profitability";

/**
 * Labor costing from logged time (confirmed rule: a COSTING view, kept
 * separate from cash net profit so salaries — already recorded as monthly
 * overhead expenses — are never double-counted).
 *
 * Cost of one entry = minutes × the person's hourly rate ÷ 60, in the person's
 * currency's minor units. Entries whose person has no hourly rate cost 0 (the
 * hours still count toward utilization).
 */
export function laborCostMinor(minutes: number, hourlyRateMinor: number | null | undefined): number {
  if (!hourlyRateMinor || hourlyRateMinor <= 0 || minutes <= 0) return 0;
  return mulDivRound(hourlyRateMinor, minutes, 60);
}

export interface ProjectCosting extends ProjectProfitability {
  /** Allocated labor cost from time entries, consolidated to EGP. */
  laborCostReporting: number;
  /** Direct expenses + labor + allocated overhead. */
  trueCostReporting: number;
  /** Revenue − true cost (fully loaded). Distinct from the cash net profit. */
  fullyLoadedProfitReporting: number;
  fullyLoadedMarginBp: number;
}

/**
 * Layer labor cost onto the per-project profitability rows. `laborByProjectReporting`
 * is the summed, EGP-converted labor cost per project (the repository does the
 * currency conversion, since rates live on people in their own currency).
 */
export function computeCosting(
  rows: ProjectProfitability[],
  laborByProjectReporting: ReadonlyMap<number, number>,
): ProjectCosting[] {
  return rows.map((r) => {
    const labor = laborByProjectReporting.get(r.projectId) ?? 0;
    const trueCost = r.directCostReporting + labor + r.overheadReporting;
    const fullyLoaded = r.revenueReporting - trueCost;
    return {
      ...r,
      laborCostReporting: labor,
      trueCostReporting: trueCost,
      fullyLoadedProfitReporting: fullyLoaded,
      fullyLoadedMarginBp: ratioBp(fullyLoaded, r.revenueReporting),
    };
  });
}

/** Format whole minutes as decimal hours (e.g. 90 → 1.5). */
export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}
