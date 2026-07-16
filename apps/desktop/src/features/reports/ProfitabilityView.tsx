import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { computeProfitability, toEgpPiasters, type OverheadRule } from "@mep/core";
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
    return computeProfitability(financials.projects, overheadTotal, rule);
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
              <th className="text-end">{t("reports.revenue")}</th>
              <th className="text-end">{t("reports.directCosts")}</th>
              <th className="text-end">{t("reports.grossProfit")}</th>
              <th className="text-end">{t("reports.grossMargin")}</th>
              <th className="text-end">{t("reports.overheadShare")}</th>
              <th className="text-end">{t("reports.netProfit")}</th>
              <th className="text-end">{t("reports.netMargin")}</th>
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
                <td className="text-end tnum">{base.format(row.revenueEgp)}</td>
                <td className="text-end tnum">{base.format(row.directCostEgp)}</td>
                <td className={cx("text-end tnum", row.grossProfitEgp < 0 && "text-red-600")}>{base.format(row.grossProfitEgp)}</td>
                <td className="text-end tnum text-slate-500">{fmt.percent(row.grossMarginBp)}</td>
                <td className="text-end tnum text-amber-600 dark:text-amber-400">{base.format(row.overheadEgp)}</td>
                <td className={cx("text-end tnum font-semibold", row.netProfitEgp >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600")}>
                  {base.format(row.netProfitEgp)}
                </td>
                <td className="text-end tnum text-slate-500">{fmt.percent(row.netMarginBp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <EmptyState message={t("common.empty")} />}
      </Card>
    </div>
  );
}
