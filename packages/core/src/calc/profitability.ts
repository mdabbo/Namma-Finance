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
  revenueReporting: number;
  directCostReporting: number;
  grossProfitReporting: number;
  grossMarginBp: number;
  overheadReporting: number;
  netProfitReporting: number;
  netMarginBp: number;
}

export function computeProfitability(
  projects: ProjectFinancials[],
  totalOverheadReporting: number,
  rule: OverheadRule,
): ProjectProfitability[] {
  const overhead = allocateOverhead(
    totalOverheadReporting,
    projects.map((p) => ({
      projectId: p.project.id,
      revenueReporting: p.revenueReporting,
      directCostReporting: p.expensesReporting,
      isActive: p.project.status === "ACTIVE",
    })),
    rule,
  );

  return projects
    .map((p) => {
      const gross = p.revenueReporting - p.expensesReporting;
      const overheadShare = overhead.get(p.project.id) ?? 0;
      const net = gross - overheadShare;
      return {
        projectId: p.project.id,
        projectCode: p.project.code,
        projectName: p.project.name,
        revenueReporting: p.revenueReporting,
        directCostReporting: p.expensesReporting,
        grossProfitReporting: gross,
        grossMarginBp: ratioBp(gross, p.revenueReporting),
        overheadReporting: overheadShare,
        netProfitReporting: net,
        netMarginBp: ratioBp(net, p.revenueReporting),
      };
    })
    .sort((a, b) => b.netProfitReporting - a.netProfitReporting);
}
