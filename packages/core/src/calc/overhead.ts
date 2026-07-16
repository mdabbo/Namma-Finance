import { allocate } from "../money/money";

/**
 * Overhead allocation (confirmed rule: revenue share by default, configurable).
 * Non-project (overhead) expenses are spread across projects so each project's
 * NET profit = gross profit − its overhead share. Uses largest-remainder
 * allocation, so the shares always sum exactly to the overhead total.
 */

export type OverheadRule = "REVENUE" | "DIRECT_COST" | "EVEN";

export interface OverheadBasis {
  projectId: number;
  revenueEgp: number;
  directCostEgp: number;
  isActive: boolean;
}

export function allocateOverhead(
  totalOverheadEgp: number,
  projects: OverheadBasis[],
  rule: OverheadRule,
): Map<number, number> {
  const result = new Map<number, number>();
  if (projects.length === 0) return result;

  let weights: number[];
  switch (rule) {
    case "REVENUE":
      weights = projects.map((p) => Math.max(0, p.revenueEgp));
      break;
    case "DIRECT_COST":
      weights = projects.map((p) => Math.max(0, p.directCostEgp));
      break;
    case "EVEN":
      weights = projects.map((p) => (p.isActive ? 1 : 0));
      break;
  }
  // Degenerate basis (no revenue yet / no costs / nothing active):
  // fall back to an even split over active projects, then over all.
  if (weights.every((w) => w === 0)) {
    weights = projects.map((p) => (p.isActive ? 1 : 0));
  }
  if (weights.every((w) => w === 0)) {
    weights = projects.map(() => 1);
  }
  const shares = allocate(totalOverheadEgp, weights);
  projects.forEach((p, i) => result.set(p.projectId, shares[i] ?? 0));
  return result;
}
