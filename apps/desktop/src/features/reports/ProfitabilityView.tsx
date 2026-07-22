import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { computeProfitability, toEgpPiasters, withAllocatedOverhead, type OverheadRule } from "@mep/core";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useSettings, useUpdateSetting } from "../../lib/settings";
import { useBaseMoney } from "../../lib/baseCurrency";
import { useFormat } from "../../lib/format";
import { Card, EmptyState, Select, cx } from "../../components/ui";

export function ProfitabilityView() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const { data: financials } = useWorkspaceFinancials();
  const { data: settings } = useSettings();
  const updateSetting = useUpdateSetting();

  const rule = settings?.overheadRule ?? "REVENUE";

  const rows = useMemo(() => {
    if (!financials) return [];
    const overheadTotal = financials.allExpenses
      .filter((e) => e.projectId === null)
      .reduce((s, e) => s + toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro), 0);
    return computeProfitability(financials.projects, overheadTotal, rule).map((row) => ({
      ...row,
      costs: financials.costsByProject.get(row.projectId)!,
      loadedCosts: withAllocatedOverhead(financials.costsByProject.get(row.projectId)!, row.overheadEgp),
    })).sort((a, b) => b.loadedCosts.forecastProfitEgp - a.loadedCosts.forecastProfitEgp);
  }, [financials, rule]);

  if (!financials) return <EmptyState message={t("common.loading")} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-slate-500">{t("reports.overheadRule")}:</span>
        <Select
          className="!w-64"
          value={rule}
          onChange={(e) => updateSetting.mutate({ key: "overheadRule", value: e.target.value as OverheadRule })}
        >
          {(["REVENUE", "DIRECT_COST", "EVEN"] as const).map((r) => (
            <option key={r} value={r}>{t(`reports.rule${r}`)}</option>
          ))}
        </Select>
      </div>

      <Card className="overflow-x-auto p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
              <th className="py-2 text-start">#</th>
              <th className="text-start">{t("projects.single")}</th>
              <th className="text-end">{t("costs.certifiedRevenue")}</th>
              <th className="text-end">{t("costs.actualCashIn")}</th>
              <th className="text-end">{t("costs.actualPaid")}</th>
              <th className="text-end">{t("costs.accrued")}</th>
              <th className="text-end">{t("costs.committed")}</th>
              <th className="text-end">{t("costs.forecast")}</th>
              <th className="text-end">{t("reports.overheadShare")}</th>
              <th className="text-end">{t("costs.actualGrossProfit")}</th>
              <th className="text-end">{t("costs.actualNetProfit")}</th>
              <th className="text-end">{t("costs.cashProfit")}</th>
              <th className="text-end">{t("costs.committedProfit")}</th>
              <th className="text-end">{t("costs.forecastProfitBeforeOverhead")}</th>
              <th className="text-end">{t("costs.forecastNetProfit")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.projectId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <td className="py-2 text-slate-400 tnum">{i + 1}</td>
                <td>
                  <p className="font-medium">{row.projectName}</p>
                  <p className="text-xs text-slate-400 tnum">{row.projectCode}</p>
                </td>
                <td className="text-end tnum">{base.format(row.costs.recognizedRevenueEgp)}</td>
                <td className="text-end tnum">{base.format(row.costs.actualCashInEgp)}</td>
                <td className="text-end tnum">{base.format(row.costs.actualPaidCostEgp)}</td>
                <td className="text-end tnum text-amber-600">{base.format(row.costs.accruedCostEgp)}</td>
                <td className="text-end tnum">{base.format(row.costs.committedCostEgp)}</td>
                <td className="text-end tnum">{base.format(row.costs.forecastCostEgp)}</td>
                <td className="text-end tnum text-amber-600 dark:text-amber-400">{base.format(row.overheadEgp)}</td>
                <td className={cx("text-end tnum font-semibold", row.costs.actualProfitEgp >= 0 ? "text-emerald-600" : "text-red-600")}>{base.format(row.costs.actualProfitEgp)}</td>
                <td className={cx("text-end tnum font-semibold", row.loadedCosts.actualProfitEgp >= 0 ? "text-emerald-600" : "text-red-600")}>{base.format(row.loadedCosts.actualProfitEgp)}</td>
                <td className={cx("text-end tnum", row.costs.cashProfitEgp < 0 && "text-red-600")}>{base.format(row.costs.cashProfitEgp)}</td>
                <td className={cx("text-end tnum", row.costs.committedProfitEgp < 0 && "text-red-600")}>{base.format(row.costs.committedProfitEgp)}</td>
                <td className={cx("text-end tnum font-semibold", row.costs.forecastProfitEgp >= 0 ? "text-emerald-600" : "text-red-600")}>
                  {base.format(row.costs.forecastProfitEgp)} <span className="text-xs text-slate-400">({fmt.percent(row.costs.forecastMarginBp)})</span>
                </td>
                <td className={cx("text-end tnum font-semibold", row.loadedCosts.forecastProfitEgp >= 0 ? "text-emerald-600" : "text-red-600")}>
                  {base.format(row.loadedCosts.forecastProfitEgp)} <span className="text-xs text-slate-400">({fmt.percent(row.loadedCosts.forecastMarginBp)})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <EmptyState message={t("common.empty")} />}
      </Card>
    </div>
  );
}
