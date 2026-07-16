import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlarmClock,
  Banknote,
  BellRing,
  Briefcase,
  CheckCircle2,
  FileSpreadsheet,
  Percent,
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
import { computeDashboardKpis, isBillable, toEgpPiasters } from "@mep/core";
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

  if (!kpis) return <EmptyState message={t("common.loading")} />;

  const currencyTick = (v: number) => new Intl.NumberFormat("en", { notation: "compact" }).format(v);
  const toMajor = (egpMinor: number) => base.convert(egpMinor) / 100;

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">{t("dashboard.title")}</h1>
        <p className="text-xs text-slate-400">{t("dashboard.consolidatedNote", { currency: base.code })}</p>
      </div>

      <div className="mb-4 grid grid-cols-5 gap-3">
        <KpiCard label={t("dashboard.kpiContractValue")} value={base.format(kpis.contractValueEgp)} icon={Briefcase} />
        <KpiCard label={t("dashboard.kpiRevenue")} value={base.format(kpis.revenueEgp)} icon={FileSpreadsheet} />
        <KpiCard label={t("dashboard.kpiCollected")} value={base.format(kpis.collectedEgp)} icon={Banknote} tone="positive" />
        <KpiCard
          label={t("dashboard.kpiOutstanding")}
          value={base.format(kpis.outstandingEgp)}
          icon={Wallet}
          tone={kpis.outstandingEgp > 0 ? "warning" : "default"}
        />
        <KpiCard label={t("dashboard.kpiExpenses")} value={base.format(kpis.expensesEgp)} icon={TrendingDown} tone="negative" />
        <KpiCard
          label={t("dashboard.kpiProfit")}
          value={base.format(kpis.profitEgp)}
          icon={TrendingUp}
          tone={kpis.profitEgp >= 0 ? "positive" : "negative"}
        />
        <KpiCard label={t("dashboard.kpiMargin")} value={fmt.percent(kpis.marginBp)} icon={Percent} />
        <KpiCard label={t("dashboard.kpiActiveProjects")} value={String(kpis.activeProjects)} icon={Briefcase} />
        <KpiCard label={t("dashboard.kpiCompletedProjects")} value={String(kpis.completedProjects)} icon={CheckCircle2} />
        <KpiCard
          label={t("dashboard.kpiOverdue")}
          value={String(kpis.overdueCertificates)}
          icon={AlarmClock}
          tone={kpis.overdueCertificates > 0 ? "negative" : "default"}
        />
      </div>

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
              <Line type="monotone" dataKey="cashIn" name={t("dashboard.cashIn")} stroke="#2563eb" strokeWidth={1.5} dot={false} />
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
              <p className="mb-2 text-lg font-semibold tnum">{base.format(fin.contractValueEgp)}</p>
              <RatioBar ratioBp={fin.collectionRatioBp} secondaryBp={fin.certifiedRatioBp} className="!h-2.5" />
              <div className="mt-1.5 flex justify-between text-[11px] text-slate-500">
                <span>{t("projects.collected")}: <b className="tnum">{fmt.percent(fin.collectionRatioBp)}</b></span>
                <span>{t("projects.certified")}: <b className="tnum">{fmt.percent(fin.certifiedRatioBp)}</b></span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
