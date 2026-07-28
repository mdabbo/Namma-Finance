import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlarmClock,
  ArrowRight,
  Banknote,
  CalendarClock,
  CircleDollarSign,
  Receipt,
  WalletCards,
} from "lucide-react";
import {
  computeDashboardOverview,
  selectOpenReceivables,
  selectUpcomingCollections,
} from "@mep/core";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { KpiCard } from "../../components/KpiCard";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionHeader,
} from "../../components/ui";
import { todayIso, useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import { financeContractInputs } from "./financeSectionModel";

const UPCOMING_LIMIT = 8;

export function FinanceOverviewPage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const workspace = useWorkspaceFinancials();
  const financials = workspace.data;

  const model = useMemo(() => {
    if (!financials) return null;
    const overview = computeDashboardOverview(financials.projects, financials.allExpenses);
    const receivables = selectOpenReceivables(financeContractInputs(financials));
    const overdueEgp = receivables
      .filter((item) => item.overdue)
      .reduce((total, item) => total + item.unpaidEgp, 0);
    return {
      overview,
      receivables,
      overdueEgp,
      upcoming: selectUpcomingCollections(receivables, todayIso(), 60),
    };
  }, [financials]);

  if (workspace.isLoading) {
    return <LoadingState label={t("common.loading")} className="min-h-[50vh]" />;
  }
  if (workspace.isError || !financials || !model) {
    return (
      <ErrorState
        title={t("common.error")}
        description={t("dashboard.loadFailed")}
        action={<Button onClick={() => void workspace.refetch()}>{t("common.retry")}</Button>}
        className="min-h-[50vh]"
      />
    );
  }

  const projectById = new Map(
    financials.projects.map((item) => [item.project.id, item.project]),
  );

  return (
    <div>
      <PageHeader
        title={t("nav.finance")}
        description={t("financeSection.overviewDescription")}
        meta={<Badge tone="info" label={t("dashboard.reportingCurrency", { currency: base.code })} />}
      />

      <section
        aria-label={t("financeSection.kpis")}
        className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
      >
        <KpiCard
          label={t("financeSection.currentReceivables")}
          value={base.format(model.overview.outstandingReceivablesEgp)}
          icon={CircleDollarSign}
          tone={model.overview.outstandingReceivablesEgp > 0 ? "warning" : "default"}
        />
        <KpiCard
          label={t("financeSection.overdueReceivables")}
          value={base.format(model.overdueEgp)}
          icon={AlarmClock}
          tone={model.overdueEgp > 0 ? "negative" : "positive"}
        />
        <KpiCard
          label={t("dashboard.cashIn")}
          value={base.format(model.overview.cashCollectedEgp)}
          icon={Banknote}
          tone="positive"
        />
        <KpiCard
          label={t("dashboard.cashOut")}
          value={base.format(model.overview.cashOutEgp)}
          icon={Receipt}
        />
        <KpiCard
          label={t("financeSection.customerCredit")}
          value={base.format(model.overview.unallocatedCustomerCreditEgp)}
          icon={WalletCards}
          tone={model.overview.unallocatedCustomerCreditEgp > 0 ? "warning" : "default"}
        />
      </section>

      <Card className="p-4">
        <SectionHeader
          title={t("financeSection.upcomingCollections")}
          description={t("financeSection.upcomingHorizon", {
            date: fmt.date(model.upcoming.horizonEndIso),
            amount: base.format(model.upcoming.totalEgp),
          })}
          actions={
            <Link
              to="/finance/receivables"
              className="text-xs font-medium text-brand-600 hover:text-brand-700 dark:text-brand-300"
            >
              {t("financeSection.receivables")}
            </Link>
          }
        />
        {model.upcoming.items.length === 0 ? (
          <EmptyState message={t("financeSection.emptyUpcoming")} className="!py-8" />
        ) : (
          <div className="divide-y divide-border-subtle">
            {model.upcoming.items.slice(0, UPCOMING_LIMIT).map((item) => {
              const project = projectById.get(item.projectId);
              return (
                <Link
                  key={item.certificateId}
                  to={`/finance/receivables?projectId=${item.projectId}`}
                  className="grid grid-cols-[minmax(0,1fr)_7rem_8rem_1rem] items-center gap-3 py-2.5 transition-colors hover:bg-surface-subtle"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium tnum">{item.certificateNumber}</p>
                    <p className="truncate text-xs text-muted">
                      {project ? `${project.code} · ${project.name}` : item.contractNumber}
                    </p>
                  </div>
                  <span className="text-xs text-muted tnum">{fmt.date(item.dueDate)}</span>
                  <span className="text-end text-sm font-medium tnum">
                    {base.format(item.unpaidEgp)}
                  </span>
                  <ArrowRight size={14} className="text-slate-400 rtl:rotate-180" aria-hidden="true" />
                </Link>
              );
            })}
          </div>
        )}
      </Card>

      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <CalendarClock size={13} aria-hidden="true" />
        {t("financeSection.upcomingNote")}
      </div>
    </div>
  );
}
