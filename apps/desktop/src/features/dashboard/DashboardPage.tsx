import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlarmClock,
  Banknote,
  BellRing,
  Briefcase,
  CheckCircle2,
  HandCoins,
  FileSpreadsheet,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { aggregateProjectCostTotals, computeDashboardKpis, isBillable, toEgpPiasters, type ProjectFinancials } from "@mep/core";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useCategories } from "../../repositories/expenses";
import { Badge, Card, EmptyState, RatioBar } from "../../components/ui";
import { KpiCard } from "../../components/KpiCard";
import { useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";

const CHART_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#64748b", "#14b8a6", "#f97316", "#a855f7", "#84cc16", "#6b7280"];

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const { data: financials } = useWorkspaceFinancials();
  const { data: categories = [] } = useCategories(true);

  const kpis = useMemo(
    () => (financials ? computeDashboardKpis(financials.projects, financials.allExpenses) : null),
    [financials],
  );

  // money KPIs in the base currency, source-aware: same-currency amounts at
  // FACE VALUE, foreign amounts via the EGP pivot (fixes the stored-vs-today
  // rate drift that made a 10,000 SAR contract read 9,596)
  const money = useMemo(() => {
    if (!financials) return null;
    const sumProjects = (pick: (p: ProjectFinancials) => number) =>
      financials.projects.reduce(
        (s, p) => s + base.convertFrom(pick(p), p.project.currency, p.project.fxRateMicro),
        0,
      );
    const contractValue = sumProjects((p) => p.contractValueMinor);
    const revenue = sumProjects((p) => p.certifiedBaseMinor);
    const billableRevenue = sumProjects((p) => p.billableRevenueMinor);
    const invoicedAmount = sumProjects((p) => p.invoicedAmountMinor);
    const profiles = [...financials.costsByProject.values()];
    const overheadEgp = financials.allExpenses.filter((expense) => expense.projectId === null)
      .reduce((sum, expense) => sum + toEgpPiasters(expense.amountMinor, expense.currency, expense.fxRateMicro), 0);
    const costTotals = aggregateProjectCostTotals(profiles, overheadEgp);
    const actualPaid = base.convert(costTotals.actualPaidCostEgp);
    const directPaid = base.convert(costTotals.directActualPaidCostEgp);
    const accrued = base.convert(costTotals.accruedCostEgp);
    const committed = base.convert(costTotals.committedCostEgp);
    const forecastCost = base.convert(costTotals.forecastCostEgp);
    const actualCashIn = base.convert(profiles.reduce((sum, profile) => sum + profile.actualCashInEgp, 0));
    return {
      contractValue,
      billableRevenue,
      revenue,
      invoicedAmount,
      certificateCollections: sumProjects((p) => p.certificateCollectionsMinor),
      advanceReceived: sumProjects((p) => p.advanceReceivedMinor),
      retentionReleased: sumProjects((p) => p.retentionReleasedMinor),
      totalActualCashIn: sumProjects((p) => p.totalActualCashInMinor),
      customerCredit: sumProjects((p) => p.unallocatedCustomerCreditMinor),
      outstanding: sumProjects((p) => p.outstandingReceivablesMinor),
      uncertified: sumProjects((p) => p.remainingUncertifiedMinor),
      retentionHeld: sumProjects((p) => p.retentionHeldMinor),
      actualPaid,
      accrued,
      committed,
      forecastCost,
      actualGrossProfit: revenue - directPaid - accrued,
      actualNetProfit: revenue - actualPaid - accrued,
      cashProfit: actualCashIn - actualPaid,
      forecastProfit: contractValue - forecastCost,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [financials, base.code]);

  /** Face-value totals per currency — no conversion at all. */
  const byCurrency = useMemo(() => {
    if (!financials) return [];
    const groups = new Map<string, { value: number; certificateCollections: number; totalCashIn: number; outstanding: number }>();
    for (const p of financials.projects) {
      const g = groups.get(p.project.currency) ?? { value: 0, certificateCollections: 0, totalCashIn: 0, outstanding: 0 };
      g.value += p.contractValueMinor;
      g.certificateCollections += p.certificateCollectionsMinor;
      g.totalCashIn += p.totalActualCashInMinor;
      g.outstanding += p.outstandingReceivablesMinor;
      groups.set(p.project.currency, g);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [financials]);

  /** Monthly series: revenue (certified base), cash in (payments), expenses — in EGP. */
  const monthly = useMemo(() => {
    if (!financials) return [];
    const buckets = new Map<string, { revenue: number; cashIn: number; expenses: number }>();
    const bucket = (date: string) => {
      const key = date.slice(0, 7);
      if (!buckets.has(key)) buckets.set(key, { revenue: 0, cashIn: 0, expenses: 0 });
      return buckets.get(key)!;
    };
    for (const state of financials.contractStates.values()) {
      const project = financials.projects.find((p) => p.project.id === state.contract.projectId)?.project;
      const toEgp = (minor: number) => (project ? toEgpPiasters(minor, project.currency, project.fxRateMicro) : minor);
      for (const cs of state.certificates) {
        if (isBillable(cs.certificate.status)) {
          bucket(cs.certificate.date).revenue += toEgp(cs.breakdown.baseMinor);
        }
      }
    }
    for (const payment of financials.cashIn) {
      bucket(payment.date).cashIn += payment.egpMinor;
    }
    for (const e of financials.allExpenses) {
      bucket(e.date).expenses += toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, v]) => ({ month, ...v, net: v.cashIn - v.expenses }));
  }, [financials]);

  const expenseByCategory = useMemo(() => {
    if (!financials) return [];
    const sums = new Map<number, number>();
    for (const e of financials.allExpenses) {
      sums.set(e.categoryId, (sums.get(e.categoryId) ?? 0) + toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro));
    }
    return [...sums.entries()]
      .map(([categoryId, value]) => {
        const cat = categories.find((c) => c.id === categoryId);
        return { name: cat ? (i18n.language === "ar" ? cat.nameAr : cat.nameEn) : "?", value: value / 100 };
      })
      .sort((a, b) => b.value - a.value);
  }, [financials, categories, i18n.language]);

  const statusDistribution = useMemo(() => {
    if (!financials) return [];
    const counts = new Map<string, number>();
    for (const p of financials.projects) {
      counts.set(p.project.status, (counts.get(p.project.status) ?? 0) + 1);
    }
    return [...counts.entries()].map(([status, count]) => ({ name: t(`status.${status}`), value: count }));
  }, [financials, t]);

  if (!kpis || !money) return <EmptyState message={t("common.loading")} />;

  const currencyTick = (v: number) => new Intl.NumberFormat("en", { notation: "compact" }).format(v);
  const toMajor = (egpMinor: number) => base.convert(egpMinor) / 100;

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">{t("dashboard.title")}</h1>
        <p className="text-xs text-slate-400">{t("dashboard.consolidatedNote", { currency: base.code })}</p>
      </div>

      <div className="mb-4 grid grid-cols-5 gap-3">
        <KpiCard label={t("cash.contractValueExcludingVat")} value={fmt.money(money!.contractValue, base.code, { compactFraction: true })} icon={Briefcase} />
        <KpiCard label={t("cash.billableRevenue")} hint={t("cash.billableRevenueHint")} value={fmt.money(money.billableRevenue, base.code, { compactFraction: true })} icon={FileSpreadsheet} />
        <KpiCard label={t("cash.certifiedRevenue")} hint={t("cash.certifiedRevenueHint")} value={fmt.money(money!.revenue, base.code, { compactFraction: true })} icon={FileSpreadsheet} />
        <KpiCard label={t("cash.invoicedAmount")} hint={t("cash.invoicedAmountHint")} value={fmt.money(money.invoicedAmount, base.code, { compactFraction: true })} icon={FileSpreadsheet} />
        <KpiCard label={t("cash.certificateCollections")} hint={t("cash.certificateCollectionsHint")} value={fmt.money(money.certificateCollections, base.code, { compactFraction: true })} icon={Banknote} tone="positive" />
        <KpiCard label={t("cash.advanceReceived")} value={fmt.money(money.advanceReceived, base.code, { compactFraction: true })} icon={Banknote} tone="positive" />
        <KpiCard label={t("cash.retentionReleased")} value={fmt.money(money.retentionReleased, base.code, { compactFraction: true })} icon={Banknote} tone="positive" />
        <KpiCard label={t("cash.totalActualCashIn")} hint={t("cash.totalActualCashInHint")} value={fmt.money(money.totalActualCashIn, base.code, { compactFraction: true })} icon={Wallet} tone="positive" />
        <KpiCard label={t("cash.customerCredit")} hint={t("cash.customerCreditHint")} value={fmt.money(money.customerCredit, base.code, { compactFraction: true })} icon={Wallet} tone={money.customerCredit > 0 ? "warning" : "default"} />
        <KpiCard
          label={t("dashboard.kpiOutstanding")}
          hint={t("cash.outstandingReceivablesHint")}
          value={fmt.money(money!.outstanding, base.code, { compactFraction: true })}
          icon={Wallet}
          tone={money!.outstanding > 0 ? "warning" : "default"}
        />
        <KpiCard label={t("cash.uncertifiedContractValue")} value={fmt.money(money.uncertified, base.code, { compactFraction: true })} icon={Briefcase} />
        <KpiCard label={t("cash.retentionHeld")} value={fmt.money(money.retentionHeld, base.code, { compactFraction: true })} icon={Wallet} />
        <KpiCard label={t("costs.actualPaid")} value={fmt.money(money.actualPaid, base.code, { compactFraction: true })} icon={TrendingDown} />
        <KpiCard label={t("costs.accrued")} value={fmt.money(money.accrued, base.code, { compactFraction: true })} icon={AlarmClock} tone={money.accrued > 0 ? "warning" : "default"} />
        <KpiCard label={t("costs.committed")} value={fmt.money(money.committed, base.code, { compactFraction: true })} icon={Briefcase} />
        <KpiCard label={t("costs.forecast")} value={fmt.money(money.forecastCost, base.code, { compactFraction: true })} icon={TrendingDown} />
        <KpiCard label={t("costs.actualGrossProfit")} value={fmt.money(money.actualGrossProfit, base.code, { compactFraction: true })} icon={TrendingUp} tone={money.actualGrossProfit >= 0 ? "positive" : "negative"} />
        <KpiCard label={t("costs.actualNetProfit")} value={fmt.money(money.actualNetProfit, base.code, { compactFraction: true })} icon={TrendingUp} tone={money.actualNetProfit >= 0 ? "positive" : "negative"} />
        <KpiCard label={t("costs.cashProfit")} value={fmt.money(money.cashProfit, base.code, { compactFraction: true })} icon={Wallet} tone={money.cashProfit >= 0 ? "positive" : "negative"} />
        <KpiCard label={t("costs.forecastProfit")} value={fmt.money(money.forecastProfit, base.code, { compactFraction: true })} icon={TrendingUp} tone={money.forecastProfit >= 0 ? "positive" : "negative"} />
        <KpiCard label={t("dashboard.kpiActiveProjects")} value={String(kpis.activeProjects)} icon={Briefcase} />
        <KpiCard label={t("dashboard.kpiCompletedProjects")} value={String(kpis.completedProjects)} icon={CheckCircle2} />
        <KpiCard
          label={t("dashboard.kpiOverdue")}
          value={String(kpis.overdueCertificates)}
          icon={AlarmClock}
          tone={kpis.overdueCertificates > 0 ? "negative" : "default"}
        />
      </div>

      {byCurrency.length > 1 && (
        <Card className="mb-4 p-4">
          <p className="mb-2 text-sm font-semibold">{t("dashboard.byCurrency")}</p>
          <div className="grid grid-cols-3 gap-x-8 gap-y-1 text-sm">
            {byCurrency.map(([code, g]) => (
              <div key={code} className="flex items-baseline justify-between gap-3">
                <span className="font-semibold tnum">{code}</span>
                <span className="text-xs text-slate-500 tnum">
                  {t("dashboard.kpiContractValue")}: <b>{fmt.money(g.value, code, { compactFraction: true })}</b>
                  {" · "}{t("cash.certificateCollections")}: <b className="text-emerald-600 dark:text-emerald-400">{fmt.money(g.certificateCollections, code, { compactFraction: true })}</b>
                  {" · "}{t("cash.totalActualCashIn")}: <b className="text-emerald-600 dark:text-emerald-400">{fmt.money(g.totalCashIn, code, { compactFraction: true })}</b>
                  {" · "}{t("dashboard.kpiOutstanding")}: <b className="text-amber-600 dark:text-amber-400">{fmt.money(g.outstanding, code, { compactFraction: true })}</b>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {financials!.readyToCollect.length > 0 && (
        <Card className="mb-4 border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900 dark:bg-emerald-900/10">
          <div className="mb-1 flex items-center gap-2">
            <BellRing size={16} className="text-emerald-600 dark:text-emerald-400" />
            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">{t("dashboard.readyToCollect")}</p>
          </div>
          <p className="mb-3 text-xs text-emerald-700/70 dark:text-emerald-400/70">{t("dashboard.readyToCollectHint")}</p>
          <div className="space-y-1.5">
            {financials!.readyToCollect.map((item) => (
              <Link
                key={item.contractId}
                to={`/projects/${item.projectId}`}
                className="flex items-center justify-between rounded-lg bg-white/70 px-3 py-2 text-sm hover:bg-white dark:bg-slate-900/50 dark:hover:bg-slate-900"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {item.projectName} <span className="text-xs text-slate-400 tnum">({item.projectCode} · {item.contractNumber})</span>
                  </p>
                  <p className="truncate text-xs text-slate-500">{item.achievedTitles.join(" · ")}</p>
                </div>
                <span className="ms-3 shrink-0 font-semibold tnum text-emerald-700 dark:text-emerald-300">
                  {fmt.money(item.readyMinor, item.currency, { compactFraction: true })}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {financials!.teamPayables.length > 0 && (
        <Card className="mb-4 border-sky-200 bg-sky-50/50 p-4 dark:border-sky-900 dark:bg-sky-900/10">
          <div className="mb-1 flex items-center gap-2">
            <HandCoins size={16} className="text-sky-600 dark:text-sky-400" />
            <p className="text-sm font-semibold text-sky-800 dark:text-sky-300">{t("dashboard.teamPayables")}</p>
          </div>
          <p className="mb-3 text-xs text-sky-700/70 dark:text-sky-400/70">{t("dashboard.teamPayablesHint")}</p>
          <div className="space-y-1.5">
            {financials!.teamPayables.map((item) => (
              <Link
                key={item.assignmentId}
                to={`/people/${item.personId}`}
                className="flex items-center justify-between rounded-lg bg-white/70 px-3 py-2 text-sm hover:bg-white dark:bg-slate-900/50 dark:hover:bg-slate-900"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {item.personName} <span className="text-xs text-slate-400 tnum">({item.projectCode} · {item.projectName})</span>
                  </p>
                  <p className="truncate text-xs text-slate-500">{item.dueTitles.join(" · ")}</p>
                </div>
                <span className="ms-3 shrink-0 font-semibold tnum text-sky-700 dark:text-sky-300">
                  {fmt.money(item.dueMinor, item.currency, { compactFraction: true })}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold">{t("dashboard.chartRevenueExpenses")}</p>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthly.map((m) => ({ ...m, revenue: toMajor(m.revenue), expenses: toMajor(m.expenses) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} reversed={i18n.dir() === "rtl"} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={currencyTick} orientation={i18n.dir() === "rtl" ? "right" : "left"} />
              <Tooltip formatter={(v) => new Intl.NumberFormat().format(Number(v))} />
              <Legend />
              <Bar dataKey="revenue" name={t("dashboard.revenue")} fill="#2563eb" radius={[4, 4, 0, 0]} />
              <Bar dataKey="expenses" name={t("dashboard.kpiExpenses")} fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold">{t("dashboard.chartCashFlow")}</p>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={monthly.map((m) => ({ ...m, net: toMajor(m.net), cashIn: toMajor(m.cashIn), expenses: toMajor(m.expenses) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} reversed={i18n.dir() === "rtl"} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={currencyTick} orientation={i18n.dir() === "rtl" ? "right" : "left"} />
              <Tooltip formatter={(v) => new Intl.NumberFormat().format(Number(v))} />
              <Legend />
              <Line type="monotone" dataKey="cashIn" name={t("cash.totalActualCashIn")} stroke="#2563eb" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="expenses" name={t("dashboard.cashOut")} stroke="#ef4444" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="net" name={t("dashboard.net")} stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold">{t("dashboard.chartExpenseBreakdown")}</p>
          {expenseByCategory.length === 0 ? (
            <EmptyState message={t("common.empty")} />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={expenseByCategory} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                  {expenseByCategory.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => new Intl.NumberFormat().format(Number(v))} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold">{t("dashboard.chartProjectStatus")}</p>
          {statusDistribution.length === 0 ? (
            <EmptyState message={t("common.empty")} />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={statusDistribution} dataKey="value" nameKey="name" outerRadius={90}>
                  {statusDistribution.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <h2 className="mb-3 text-sm font-semibold">{t("dashboard.projectCards")}</h2>
      <div className="grid grid-cols-3 gap-3">
        {financials!.projects.map((fin) => (
          <Link key={fin.project.id} to={`/projects/${fin.project.id}`}>
            <Card className="p-4 transition-shadow hover:shadow-md">
              <div className="mb-2 flex items-start justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{fin.project.name}</p>
                  <p className="text-xs text-slate-400 tnum">{fin.project.code}</p>
                </div>
                <Badge value={fin.project.status} label={t(`status.${fin.project.status}`)} />
              </div>
              <p className="mb-2 text-lg font-semibold tnum">
                {base.formatFrom(fin.contractValueMinor, fin.project.currency, fin.project.fxRateMicro)}
              </p>
              <RatioBar ratioBp={fin.collectionRatioBp} secondaryBp={fin.certifiedRatioBp} className="!h-2.5" />
              <div className="mt-1.5 flex justify-between text-[11px] text-slate-500">
                <span>{t("cash.certificateCollections")}: <b className="tnum">{fmt.percent(fin.collectionRatioBp)}</b></span>
                <span>{t("projects.certified")}: <b className="tnum">{fmt.percent(fin.certifiedRatioBp)}</b></span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
