import { ratioBp } from "../money/money";
import type { ProjectFinancials } from "./aggregate";
import { allocateOverhead, type OverheadRule } from "./overhead";

/**
 * Per-project profitability (Phase 2):
 *   gross profit = certified revenue − direct project expenses
 *   net profit   = gross profit − allocated overhead share
 * All in EGP piasters (the internal pivot currency).
 */

export interface ProjectProfitability {
  projectId: number;
  projectCode: string;
  projectName: string;
  revenueEgp: number;
  directCostEgp: number;
  grossProfitEgp: number;
  grossMarginBp: number;
  overheadEgp: number;
  netProfitEgp: number;
  netMarginBp: number;
}

export function computeProfitability(
  projects: ProjectFinancials[],
  totalOverheadEgp: number,
  rule: OverheadRule,
): ProjectProfitability[] {
  const overhead = allocateOverhead(
    totalOverheadEgp,
    projects.map((p) => ({
      projectId: p.project.id,
      revenueEgp: p.revenueEgp,
      directCostEgp: p.expensesEgp,
      isActive: p.project.status === "ACTIVE",
    })),
    rule,
  );

  return projects
    .map((p) => {
      const gross = p.revenueEgp - p.expensesEgp;
      const overheadShare = overhead.get(p.project.id) ?? 0;
      const net = gross - overheadShare;
      return {
        projectId: p.project.id,
        projectCode: p.project.code,
        projectName: p.project.name,
        revenueEgp: p.revenueEgp,
        directCostEgp: p.expensesEgp,
        grossProfitEgp: gross,
        grossMarginBp: ratioBp(gross, p.revenueEgp),
        overheadEgp: overheadShare,
        netProfitEgp: net,
        netMarginBp: ratioBp(net, p.revenueEgp),
      };
    })
    .sort((a, b) => b.netProfitEgp - a.netProfitEgp);
}
