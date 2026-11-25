import { ratioBp } from "../money/money";

export interface ProjectCostProfile {
  projectId: number;
  recognizedRevenueReporting: number;
  forecastRevenueReporting: number;
  actualCashInReporting: number;
  actualPaidCostReporting: number;
  accruedCostReporting: number;
  committedCostReporting: number;
  forecastCostReporting: number;
  actualProfitReporting: number;
  cashProfitReporting: number;
  committedProfitReporting: number;
  forecastProfitReporting: number;
  actualMarginBp: number;
  forecastMarginBp: number;
}

export interface ProjectCostInput {
  projectId: number;
  recognizedRevenueReporting: number;
  forecastRevenueReporting: number;
  actualCashInReporting: number;
  actualPaidCostReporting: number;
  accruedCostReporting: number;
  committedCostReporting: number;
}

export interface PortfolioCostTotals {
  directActualPaidCostReporting: number;
  overheadPaidCostReporting: number;
  actualPaidCostReporting: number;
  accruedCostReporting: number;
  committedCostReporting: number;
  forecastCostReporting: number;
}

/** Derive cash, accrual, commitment, and forecast views without storing totals. */
export function computeProjectCostProfile(input: ProjectCostInput): ProjectCostProfile {
  const incurred = input.actualPaidCostReporting + input.accruedCostReporting;
  const forecastCost = Math.max(incurred, input.committedCostReporting);
  const actualProfit = input.recognizedRevenueReporting - incurred;
  const forecastProfit = input.forecastRevenueReporting - forecastCost;
  return {
    ...input,
    forecastCostReporting: forecastCost,
    actualProfitReporting: actualProfit,
    cashProfitReporting: input.actualCashInReporting - input.actualPaidCostReporting,
    committedProfitReporting: input.forecastRevenueReporting - input.committedCostReporting,
    forecastProfitReporting: forecastProfit,
    actualMarginBp: ratioBp(actualProfit, input.recognizedRevenueReporting),
    forecastMarginBp: ratioBp(forecastProfit, input.forecastRevenueReporting),
  };
}

/** Apply allocated overhead consistently to every cost/profit view. */
export function withAllocatedOverhead(profile: ProjectCostProfile, overheadReporting: number): ProjectCostProfile {
  return computeProjectCostProfile({
    projectId: profile.projectId,
    recognizedRevenueReporting: profile.recognizedRevenueReporting,
    forecastRevenueReporting: profile.forecastRevenueReporting,
    actualCashInReporting: profile.actualCashInReporting,
    actualPaidCostReporting: profile.actualPaidCostReporting + overheadReporting,
    accruedCostReporting: profile.accruedCostReporting,
    committedCostReporting: profile.committedCostReporting + overheadReporting,
  });
}

/** Sum project forecasts after each project's incurred/commitment maximum is resolved. */
export function aggregateProjectCostTotals(
  profiles: readonly ProjectCostProfile[],
  overheadPaidReporting: number,
): PortfolioCostTotals {
  const directActualPaidCostReporting = profiles.reduce((sum, profile) => sum + profile.actualPaidCostReporting, 0);
  return {
    directActualPaidCostReporting,
    overheadPaidCostReporting: overheadPaidReporting,
    actualPaidCostReporting: directActualPaidCostReporting + overheadPaidReporting,
    accruedCostReporting: profiles.reduce((sum, profile) => sum + profile.accruedCostReporting, 0),
    committedCostReporting: profiles.reduce((sum, profile) => sum + profile.committedCostReporting, 0) + overheadPaidReporting,
    forecastCostReporting: profiles.reduce((sum, profile) => sum + profile.forecastCostReporting, 0) + overheadPaidReporting,
  };
}
