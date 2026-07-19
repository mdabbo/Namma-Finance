import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { computeCosting, computeProfitability, toEgpPiasters } from "@mep/core";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useSettings } from "../../lib/settings";
import { useBaseMoney } from "../../lib/baseCurrency";
import { useFormat } from "../../lib/format";
import { Card, EmptyState, cx } from "../../components/ui";

/**
 * Fully-loaded costing: profitability plus logged labor cost. Labor is
 * analytical — it forms "true cost" and "fully-loaded profit" but never
 * changes the cash net profit (salaries stay counted as overhead only).
 */
export function CostingView() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const { data: financials } = useWorkspaceFinancials();
  const { data: settings } = useSettings();

  const rows = useMemo(() => {
    if (!financials) return [];
    const overheadTotal = financials.allExpenses
      .filter((e) => e.projectId === null)
      .reduce((s, e) => s + toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro), 0);
    const profitability = computeProfitability(financials.projects, overheadTotal, settings?.overheadRule ?? "REVENUE");
    return computeCosting(profitability, financials.laborByProjectEgp);
  }, [financials, settings?.overheadRule]);

  if (!financials) return <EmptyState message={t("common.loading")} />;

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">{t("reports.costingNote")}</p>
      <Card className="overflow-x-auto p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
              <th className="py-2 text-start">{t("projects.single")}</th>
              <th className="text-end">{t("reports.revenue")}</th>
              <th className="text-end">{t("reports.directCosts")}</th>
              <th className="text-end">{t("reports.laborCost")}</th>
              <th className="text-end">{t("reports.overheadShare")}</th>
              <th className="text-end">{t("reports.trueCost")}</th>
              <th className="text-end">{t("reports.fullyLoadedProfit")}</th>
              <th className="text-end">{t("reports.fullyLoadedMargin")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.projectId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <td className="py-2">
                  <p className="font-medium">{r.projectName}</p>
                  <p className="text-xs text-slate-400 tnum">{r.projectCode}</p>
                </td>
                <td className="text-end tnum">{base.format(r.revenueEgp)}</td>
                <td className="text-end tnum">{base.format(r.directCostEgp)}</td>
                <td className="text-end tnum text-indigo-600 dark:text-indigo-400">{base.format(r.laborCostEgp)}</td>
                <td className="text-end tnum text-amber-600 dark:text-amber-400">{base.format(r.overheadEgp)}</td>
                <td className="text-end tnum">{base.format(r.trueCostEgp)}</td>
                <td className={cx("text-end tnum font-semibold", r.fullyLoadedProfitEgp >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600")}>
                  {base.format(r.fullyLoadedProfitEgp)}
                </td>
                <td className="text-end tnum text-slate-500">{fmt.percent(r.fullyLoadedMarginBp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <EmptyState message={t("common.empty")} />}
      </Card>
    </div>
  );
}
