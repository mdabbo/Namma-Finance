import { ratioBp } from "../money/money";

export interface ProjectCostProfile {
  projectId: number;
  recognizedRevenueEgp: number;
  forecastRevenueEgp: number;
  actualCashInEgp: number;
  actualPaidCostEgp: number;
  accruedCostEgp: number;
  committedCostEgp: number;
  forecastCostEgp: number;
  actualProfitEgp: number;
  cashProfitEgp: number;
  committedProfitEgp: number;
  forecastProfitEgp: number;
  actualMarginBp: number;
  forecastMarginBp: number;
}

export interface ProjectCostInput {
  projectId: number;
  recognizedRevenueEgp: number;
  forecastRevenueEgp: number;
  actualCashInEgp: number;
  actualPaidCostEgp: number;
  accruedCostEgp: number;
  committedCostEgp: number;
}

export interface PortfolioCostTotals {
  directActualPaidCostEgp: number;
  overheadPaidCostEgp: number;
  actualPaidCostEgp: number;
  accruedCostEgp: number;
  committedCostEgp: number;
  forecastCostEgp: number;
}

/** Derive cash, accrual, commitment, and forecast views without storing totals. */
export function computeProjectCostProfile(input: ProjectCostInput): ProjectCostProfile {
  const incurred = input.actualPaidCostEgp + input.accruedCostEgp;
  const forecastCost = Math.max(incurred, input.committedCostEgp);
  const actualProfit = input.recognizedRevenueEgp - incurred;
  const forecastProfit = input.forecastRevenueEgp - forecastCost;
  return {
    ...input,
    forecastCostEgp: forecastCost,
    actualProfitEgp: actualProfit,
    cashProfitEgp: input.actualCashInEgp - input.actualPaidCostEgp,
    committedProfitEgp: input.forecastRevenueEgp - input.committedCostEgp,
    forecastProfitEgp: forecastProfit,
    actualMarginBp: ratioBp(actualProfit, input.recognizedRevenueEgp),
    forecastMarginBp: ratioBp(forecastProfit, input.forecastRevenueEgp),
  };
}

/** Apply allocated overhead consistently to every cost/profit view. */
export function withAllocatedOverhead(profile: ProjectCostProfile, overheadEgp: number): ProjectCostProfile {
  return computeProjectCostProfile({
    projectId: profile.projectId,
    recognizedRevenueEgp: profile.recognizedRevenueEgp,
    forecastRevenueEgp: profile.forecastRevenueEgp,
    actualCashInEgp: profile.actualCashInEgp,
    actualPaidCostEgp: profile.actualPaidCostEgp + overheadEgp,
    accruedCostEgp: profile.accruedCostEgp,
    committedCostEgp: profile.committedCostEgp + overheadEgp,
  });
}

/** Sum project forecasts after each project's incurred/commitment maximum is resolved. */
export function aggregateProjectCostTotals(
  profiles: readonly ProjectCostProfile[],
  overheadPaidEgp: number,
): PortfolioCostTotals {
  const directActualPaidCostEgp = profiles.reduce((sum, profile) => sum + profile.actualPaidCostEgp, 0);
  return {
    directActualPaidCostEgp,
    overheadPaidCostEgp: overheadPaidEgp,
    actualPaidCostEgp: directActualPaidCostEgp + overheadPaidEgp,
    accruedCostEgp: profiles.reduce((sum, profile) => sum + profile.accruedCostEgp, 0),
    committedCostEgp: profiles.reduce((sum, profile) => sum + profile.committedCostEgp, 0) + overheadPaidEgp,
    forecastCostEgp: profiles.reduce((sum, profile) => sum + profile.forecastCostEgp, 0) + overheadPaidEgp,
  };
}
