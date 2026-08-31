import { useMemo, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlarmClock,
  ArrowRight,
  Banknote,
  BriefcaseBusiness,
  CircleDollarSign,
  FileCheck2,
  HandCoins,
  WalletCards,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  computeDashboardAttention,
  computeDashboardOverview,
  minorPerMajor,
} from "@mep/core";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useClients } from "../../repositories/clients";
import { useRecentAuditRecords, type AuditRecord } from "../../repositories/audit";
import { parseDemoWorkspace } from "../../repositories/demo";
import { useSettings } from "../../lib/settings";
import { onboardingStatus } from "../onboarding/onboardingModel";
import { OnboardingPanel, OnboardingResumeCard } from "../onboarding/OnboardingPanel";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  PageHeader,
  RatioBar,
  SectionHeader,
  cx,
} from "../../components/ui";
import { KpiCard } from "../../components/KpiCard";
import { useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import {
  DASHBOARD_ATTENTION_ROUTES,
  activityRoute,
  buildMonthlyCashSeries,
  selectProjectHealth,
} from "./dashboardModel";

type AttentionTone = "danger" | "warning" | "info" | "success";

const ATTENTION_STYLES: Record<AttentionTone, { icon: string; hover: string }> = {
  danger: {
    icon: "bg-red-50 text-red-600 dark:bg-red-950/60 dark:text-red-300",
    hover: "hover:border-red-200 dark:hover:border-red-900",
  },
  warning: {
    icon: "bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-300",
    hover: "hover:border-amber-200 dark:hover:border-amber-900",
  },
  info: {
    icon: "bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300",
    hover: "hover:border-blue-200 dark:hover:border-blue-900",
  },
  success: {
    icon: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300",
    hover: "hover:border-emerald-200 dark:hover:border-emerald-900",
  },
};

const ACTIVITY_ACTION_KEYS: Record<string, string> = {
  CREATE: "dashboard.activityActions.create",
  UPDATE: "dashboard.activityActions.update",
  DELETE: "dashboard.activityActions.delete",
  ARCHIVE: "dashboard.activityActions.archive",
  RESTORE: "dashboard.activityActions.restore",
  STATUS_CHANGE: "dashboard.activityActions.status",
  VOID: "dashboard.activityActions.void",
  BACKUP: "dashboard.activityActions.backup",
  SETTING_CHANGE: "dashboard.activityActions.settings",
};

const ACTIVITY_ENTITY_KEYS: Record<string, string> = {
  project: "dashboard.activityEntities.project",
  client: "dashboard.activityEntities.client",
  contract: "dashboard.activityEntities.contract",
  contract_revision: "dashboard.activityEntities.contract",
  payment_certificate: "dashboard.activityEntities.certificate",
  payment: "dashboard.activityEntities.payment",
  payment_allocation: "dashboard.activityEntities.payment",
  expense: "dashboard.activityEntities.expense",
  recurring_expense: "dashboard.activityEntities.expense",
  person: "dashboard.activityEntities.person",
  project_assignment: "dashboard.activityEntities.assignment",
  person_payment: "dashboard.activityEntities.teamPayment",
  time_entry: "dashboard.activityEntities.timeEntry",
  project_stage: "dashboard.activityEntities.projectStage",
  backup: "dashboard.activityEntities.backup",
  setting: "dashboard.activityEntities.settings",
};

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const workspace = useWorkspaceFinancials();
  const clients = useClients(false);
  const settingsQuery = useSettings();
  const recentActivity = useRecentAuditRecords(6);

  const financials = workspace.data;
  const money = useMemo(() => {
    if (!financials) return null;
    const overview = computeDashboardOverview(
      financials.projects,
      financials.allExpenses,
    );
    return {
      contractValue: base.convert(overview.contractValueEgp),
      totalCashIn: base.convert(overview.totalCashInEgp),
      outstanding: base.convert(overview.outstandingReceivablesEgp),
      netCash: base.convert(overview.netCashPositionEgp),
    };
    // `base.code` changes the EGP-to-reporting-currency conversion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [financials, base.code]);

  const monthly = useMemo(
    () =>
      financials
        ? buildMonthlyCashSeries(financials.cashIn, financials.allExpenses)
        : [],
    [financials],
  );

  const healthProjects = useMemo(
    () => selectProjectHealth(financials?.projects ?? [], 5),
    [financials],
  );

  const attention = useMemo(() => {
    if (!financials || !money) return [];
    const projectById = new Map(
      financials.projects.map((project) => [
        project.project.id,
        project.project,
      ]),
    );
    const summary = computeDashboardAttention({
      contracts: [...financials.contractStates.values()].flatMap((state) => {
        const project = projectById.get(state.contract.projectId);
        return project ? [{
          state,
          projectCurrency: project.currency,
          projectFxRateMicro: project.fxRateMicro,
        }] : [];
      }),
      projects: financials.projects,
      readyToInvoiceEgp: financials.readyToCollect.map((item) => item.readyEgp),
      teamPaymentsDueEgp: financials.teamPayables.map((item) => item.dueEgp),
    });

    return [
      {
        id: "overdue",
        title: t("dashboard.attention.overdue"),
        detail: t("dashboard.attention.overdueDetail", {
          count: summary.overdueCertificates.count,
        }),
        count: summary.overdueCertificates.count,
        amount: base.convert(summary.overdueCertificates.amountEgp),
        to: DASHBOARD_ATTENTION_ROUTES.overdue,
        icon: AlarmClock,
        tone: "danger" as const,
      },
      {
        id: "ready",
        title: t("dashboard.attention.ready"),
        detail: t("dashboard.attention.readyDetail", {
          count: summary.readyToInvoice.count,
        }),
        count: summary.readyToInvoice.count,
        amount: base.convert(summary.readyToInvoice.amountEgp),
        to: DASHBOARD_ATTENTION_ROUTES.readyToInvoice,
        icon: FileCheck2,
        tone: "success" as const,
      },
      {
        id: "unallocated",
        title: t("dashboard.attention.unallocated"),
        detail: t("dashboard.attention.unallocatedDetail", {
          count: summary.unallocatedPayments.count,
        }),
        count: summary.unallocatedPayments.count,
        amount: base.convert(summary.unallocatedPayments.amountEgp),
        to: DASHBOARD_ATTENTION_ROUTES.unallocated,
        icon: WalletCards,
        tone: "warning" as const,
      },
      {
        id: "team",
        title: t("dashboard.attention.team"),
        detail: t("dashboard.attention.teamDetail", {
          count: summary.teamPaymentsDue.count,
        }),
        count: summary.teamPaymentsDue.count,
        amount: base.convert(summary.teamPaymentsDue.amountEgp),
        to: DASHBOARD_ATTENTION_ROUTES.teamPayments,
        icon: HandCoins,
        tone: "info" as const,
      },
    ].filter((item) => item.count > 0 || item.amount > 0);
    // `base.code` changes the EGP-to-reporting-currency conversion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [financials, money, base.code, t]);

  if (workspace.isLoading || clients.isLoading || settingsQuery.isLoading) {
    return <LoadingState label={t("common.loading")} className="min-h-[50vh]" />;
  }
  if (workspace.isError || clients.isError || !financials || !money) {
    return (
      <ErrorState
        title={t("common.error")}
        description={t("dashboard.loadFailed")}
        action={
          <Button
            onClick={() => {
              void workspace.refetch();
              void clients.refetch();
            }}
          >
            {t("common.retry")}
          </Button>
        }
        className="min-h-[50vh]"
      />
    );
  }

  const certificateCount = [...financials.contractStates.values()].reduce(
    (sum, state) => sum + state.certificates.length,
    0,
  );
  const isNewWorkspace =
    certificateCount === 0 &&
    financials.cashIn.length === 0 &&
    financials.allExpenses.length === 0;

  if (isNewWorkspace) {
    const settings = settingsQuery.data;
    const onboarding = onboardingStatus({
      companyName: settings?.companyName ?? "",
      currencyConfirmed: settings?.onboardingCurrencyDone ?? false,
      numberingConfirmed: settings?.onboardingNumberingDone ?? false,
      clientCount: clients.data?.length ?? 0,
      projectCount: financials.projects.length,
      contractCount: financials.contractStates.size,
      skipped: settings?.onboardingSkipped ?? false,
    });
    const demoLoaded = parseDemoWorkspace(settings?.demoWorkspace ?? "") !== null;
    return (
      <div>
        <DashboardHeader currency={base.code} />
        {onboarding.showPanel ? (
          <OnboardingPanel
            status={onboarding}
            firstProjectId={financials.projects[0]?.project.id ?? null}
            demoLoaded={demoLoaded}
          />
        ) : (
          <OnboardingResumeCard finished={onboarding.finished} demoLoaded={demoLoaded} />
        )}
      </div>
    );
  }

  const currencyScale = minorPerMajor(base.code);
  const cashChart = monthly.map((point) => ({
    month: point.month,
    cashIn: base.convert(point.cashInEgp) / currencyScale,
    cashOut: base.convert(point.cashOutEgp) / currencyScale,
  }));
  const healthChart = healthProjects.map((project) => ({
    name:
      project.project.name.length > 18
        ? `${project.project.name.slice(0, 16)}…`
        : project.project.name,
    progress: project.project.progressBp / 100,
    certified: project.certifiedRatioBp / 100,
    collected: project.collectionRatioBp / 100,
  }));
  const compactTick = (value: number) =>
    new Intl.NumberFormat(i18n.language === "ar" ? "ar-EG" : "en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);

  return (
    <div>
      <DashboardHeader currency={base.code} />

      <section
        aria-label={t("dashboard.primaryKpis")}
        className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4"
      >
        <KpiCard
          label={t("dashboard.contractValue")}
          hint={t("dashboard.contractValueHint")}
          value={fmt.money(money.contractValue, base.code, {
            compactFraction: true,
          })}
          icon={BriefcaseBusiness}
        />
        <KpiCard
          label={t("dashboard.totalCashIn")}
          hint={t("dashboard.totalCashInHint")}
          value={fmt.money(money.totalCashIn, base.code, {
            compactFraction: true,
          })}
          icon={Banknote}
          tone="positive"
        />
        <KpiCard
          label={t("dashboard.kpiOutstanding")}
          hint={t("cash.outstandingReceivablesHint")}
          value={fmt.money(money.outstanding, base.code, {
            compactFraction: true,
          })}
          icon={CircleDollarSign}
          tone={money.outstanding > 0 ? "warning" : "default"}
        />
        <KpiCard
          label={t("dashboard.netCashPosition")}
          hint={t("dashboard.netCashPositionHint")}
          value={fmt.money(money.netCash, base.code, {
            compactFraction: true,
          })}
          icon={WalletCards}
          tone={money.netCash >= 0 ? "positive" : "negative"}
        />
      </section>

      {attention.length > 0 && (
        <section className="mb-5" aria-labelledby="attention-heading">
          <SectionHeader
            title={
              <span id="attention-heading">{t("dashboard.attention.title")}</span>
            }
            description={t("dashboard.attention.description")}
          />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {attention.map((item) => (
              <AttentionCard
                key={item.id}
                title={item.title}
                detail={item.detail}
                amount={fmt.money(item.amount, base.code, {
                  compactFraction: true,
                })}
                to={item.to}
                icon={item.icon}
                tone={item.tone}
              />
            ))}
          </div>
        </section>
      )}

      {(cashChart.length > 0 || healthChart.length > 0) && (
        <section
          className="mb-5 grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
          aria-label={t("dashboard.insights")}
        >
          {cashChart.length > 0 && (
            <Card className="min-w-0 p-4">
              <SectionHeader
                title={t("dashboard.cashInVsCashOut")}
                description={t("dashboard.lastTwelveMonths")}
              />
              <ResponsiveContainer width="100%" height={224}>
                <BarChart data={cashChart}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--ui-border-subtle)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 10 }}
                    reversed={i18n.dir() === "rtl"}
                  />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    tickFormatter={compactTick}
                    orientation={i18n.dir() === "rtl" ? "right" : "left"}
                    width={50}
                  />
                  <Tooltip
                    formatter={(value) =>
                      fmt.money(
                        Math.round(Number(value) * currencyScale),
                        base.code,
                        { compactFraction: true },
                      )
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar
                    dataKey="cashIn"
                    name={t("dashboard.cashIn")}
                    fill="#2563eb"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={26}
                  />
                  <Bar
                    dataKey="cashOut"
                    name={t("dashboard.cashOut")}
                    fill="#94a3b8"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={26}
                  />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          )}

          {healthChart.length > 0 && (
            <Card className="min-w-0 p-4">
              <SectionHeader
                title={t("dashboard.projectHealth")}
                description={t("dashboard.projectHealthHint")}
              />
              <ResponsiveContainer width="100%" height={224}>
                <BarChart data={healthChart} layout="vertical" barGap={1}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--ui-border-subtle)"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    tick={{ fontSize: 10 }}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 10 }}
                    width={92}
                    orientation={i18n.dir() === "rtl" ? "right" : "left"}
                  />
                  <Tooltip formatter={(value) => `${Number(value).toFixed(0)}%`} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar
                    dataKey="progress"
                    name={t("dashboard.progress")}
                    fill="#64748b"
                    radius={3}
                    barSize={6}
                  />
                  <Bar
                    dataKey="certified"
                    name={t("projects.certified")}
                    fill="#60a5fa"
                    radius={3}
                    barSize={6}
                  />
                  <Bar
                    dataKey="collected"
                    name={t("dashboard.collected")}
                    fill="#10b981"
                    radius={3}
                    barSize={6}
                  />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          )}
        </section>
      )}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)]">
        {healthProjects.length > 0 && (
          <Card className="min-w-0 overflow-hidden">
            <div className="p-4 pb-2">
              <SectionHeader
                title={t("dashboard.topActiveProjects")}
                actions={
                  <Link
                    to="/projects"
                    className="text-xs font-medium text-brand-600 hover:text-brand-700 dark:text-brand-300"
                  >
                    {t("dashboard.viewAll")}
                  </Link>
                }
              />
            </div>
            <div className="divide-y divide-border-subtle">
              {healthProjects.map((project) => (
                <Link
                  key={project.project.id}
                  to={`/projects/${project.project.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_8rem_9rem_1rem] items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-subtle"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {project.project.name}
                    </p>
                    <p className="truncate text-xs text-muted tnum">
                      {project.project.code} ·{" "}
                      {base.format(project.contractValueEgp)}
                    </p>
                  </div>
                  <Badge
                    value={project.project.status}
                    label={t(`status.${project.project.status}`)}
                  />
                  <div>
                    <RatioBar
                      ratioBp={project.collectionRatioBp}
                      secondaryBp={project.certifiedRatioBp}
                    />
                    <p className="mt-1 text-end text-[10px] text-muted tnum">
                      {fmt.percent(project.collectionRatioBp)}
                    </p>
                  </div>
                  <ArrowRight
                    size={14}
                    className="text-slate-400 rtl:rotate-180"
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </div>
          </Card>
        )}

        {(recentActivity.data?.length ?? 0) > 0 && (
          <Card className="min-w-0 p-4">
            <SectionHeader
              title={t("dashboard.recentActivity")}
              actions={
                <Link
                  to="/settings/audit"
                  className="text-xs font-medium text-brand-600 hover:text-brand-700 dark:text-brand-300"
                >
                  {t("dashboard.viewAuditLog")}
                </Link>
              }
            />
            <div className="space-y-1">
              {recentActivity.data!.map((record) => (
                <ActivityRow key={record.id} record={record} />
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function DashboardHeader({ currency }: { currency: string }) {
  const { t } = useTranslation();
  return (
    <PageHeader
      title={t("dashboard.title")}
      description={t("dashboard.subtitle")}
      meta={
        <Badge
          tone="info"
          label={t("dashboard.reportingCurrency", { currency })}
        />
      }
    />
  );
}

function AttentionCard({
  title,
  detail,
  amount,
  to,
  icon: Icon,
  tone,
}: {
  title: string;
  detail: string;
  amount: string;
  to: string;
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  tone: AttentionTone;
}) {
  const styles = ATTENTION_STYLES[tone];
  return (
    <Link to={to} className="group">
      <Card
        className={cx(
          "h-full p-3.5 transition-[border-color,box-shadow] group-hover:shadow-sm",
          styles.hover,
        )}
      >
        <div className="flex items-start gap-3">
          <div className={cx("shrink-0 rounded-lg p-2", styles.icon)}>
            <Icon size={17} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="truncate text-sm font-semibold">{title}</p>
              <ArrowRight
                size={14}
                className="mt-0.5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
                aria-hidden="true"
              />
            </div>
            <p className="mt-1 text-lg font-semibold tracking-tight tnum">
              {amount}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted">{detail}</p>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function ActivityRow({ record }: { record: AuditRecord }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const actionKey =
    ACTIVITY_ACTION_KEYS[record.action] ?? "dashboard.activityActions.other";
  const entityKey =
    ACTIVITY_ENTITY_KEYS[record.entityType] ??
    "dashboard.activityEntities.record";
  return (
    <Link
      to={activityRoute(record)}
      className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-surface-subtle"
    >
      <div className="mt-0.5 rounded-full bg-surface-subtle p-1.5 text-slate-500">
        <Activity size={13} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">
          {t("dashboard.activityLine", {
            action: t(actionKey),
            entity: t(entityKey),
          })}
        </p>
        <p className="mt-0.5 text-[11px] text-muted tnum">
          {fmt.date(record.timestamp.slice(0, 10))}
        </p>
      </div>
    </Link>
  );
}
