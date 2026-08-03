import { useTranslation } from "react-i18next";
import { Activity, CircleAlert } from "lucide-react";
import { type WorkspaceFinancials } from "../../repositories/financials";
import { type ProjectListItem } from "../../repositories/projects";
import { type AuditRecord } from "../../repositories/audit";
import { Badge, Card, EmptyState, RatioBar, SectionHeader, cx } from "../../components/ui";
import { useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import { StagesTab } from "./StagesTab";
import { projectAttentionSummary, type ProjectFinanceView, type ProjectWorkspaceTab } from "./projectWorkspaceModel";

const ACTIVITY_ACTION_KEYS: Record<string, string> = {
  CREATE: "dashboard.activityActions.create",
  UPDATE: "dashboard.activityActions.update",
  DELETE: "dashboard.activityActions.delete",
  ARCHIVE: "dashboard.activityActions.archive",
  RESTORE: "dashboard.activityActions.restore",
  STATUS_CHANGE: "dashboard.activityActions.status",
  VOID: "dashboard.activityActions.void",
};

const ACTIVITY_ENTITY_KEYS: Record<string, string> = {
  project: "dashboard.activityEntities.project",
  contract: "dashboard.activityEntities.contract",
  contract_revision: "dashboard.activityEntities.contract",
  variation_order: "dashboard.activityEntities.contract",
  payment_certificate: "dashboard.activityEntities.certificate",
  payment: "dashboard.activityEntities.payment",
  payment_allocation: "dashboard.activityEntities.payment",
  expense: "dashboard.activityEntities.expense",
  person: "dashboard.activityEntities.person",
  project_assignment: "dashboard.activityEntities.assignment",
  person_payment: "dashboard.activityEntities.teamPayment",
  time_entry: "dashboard.activityEntities.timeEntry",
  project_stage: "dashboard.activityEntities.projectStage",
};

export function ProjectSummary({
  project,
  financials,
  activity,
  showFinancials,
  onNavigate,
  onOpenActivity,
}: {
  project: ProjectListItem;
  financials: WorkspaceFinancials | undefined;
  activity: AuditRecord[];
  showFinancials: boolean;
  onNavigate: (
    tab: ProjectWorkspaceTab,
    financeView?: ProjectFinanceView,
  ) => void;
  onOpenActivity: (record: AuditRecord) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const fin = financials?.projects.find(
    (item) => item.project.id === project.id,
  );
  const cost = financials?.costsByProject.get(project.id);
  const attention = projectAttentionSummary({
    projectId: project.id,
    overdueCertificates: fin?.overdueCertificates ?? 0,
    unallocatedCustomerCreditEgp: fin?.unallocatedCustomerCreditEgp ?? 0,
    readyToCollect: financials?.readyToCollect ?? [],
    teamPayables: financials?.teamPayables ?? [],
  });

  return (
    <div className="space-y-5">
      {showFinancials && (
        <section>
          <SectionHeader
            title={t("projects.financialSummary")}
            description={t("dashboard.reportingCurrency", {
              currency: base.code,
            })}
          />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <ProjectMetric
              label={t("cash.contractValueExcludingVat")}
              value={base.format(fin?.contractValueEgp ?? 0)}
            />
            <ProjectMetric
              label={t("cash.certifiedRevenue")}
              value={base.format(fin?.revenueEgp ?? 0)}
              hint={fmt.percent(fin?.certifiedRatioBp ?? 0)}
            />
            <ProjectMetric
              label={t("cash.certificateCollections")}
              value={base.format(fin?.certificateCollectionsEgp ?? 0)}
              hint={fmt.percent(fin?.collectionRatioBp ?? 0)}
              tone="success"
            />
            <ProjectMetric
              label={t("cash.outstandingReceivables")}
              value={base.format(fin?.outstandingEgp ?? 0)}
              tone="warning"
            />
            <ProjectMetric
              label={t("projects.projectCost")}
              value={base.format(cost?.actualPaidCostEgp ?? 0)}
            />
            <ProjectMetric
              label={t("costs.actualProfit")}
              value={base.format(cost?.actualProfitEgp ?? 0)}
              hint={fmt.percent(cost?.actualMarginBp ?? 0)}
              tone={(cost?.actualProfitEgp ?? 0) >= 0 ? "success" : "danger"}
            />
          </div>
        </section>
      )}

      <div
        className={cx(
          "grid gap-5",
          showFinancials ? "xl:grid-cols-[1.15fr_0.85fr]" : "xl:grid-cols-2",
        )}
      >
        <Card className="p-4">
          <SectionHeader title={t("projects.progress")} />
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-2xl font-semibold tnum">
              {fmt.percent(project.progressBp)}
            </span>
            <span className="text-xs text-muted">
              {t(`status.${project.status}`)}
            </span>
          </div>
          <RatioBar ratioBp={project.progressBp} className="mt-3" />
          {showFinancials && (
            <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border-subtle pt-4 text-xs">
              <div>
                <p className="text-muted">{t("cash.certifiedRevenue")}</p>
                <p className="mt-1 font-semibold tnum">
                  {fmt.percent(fin?.certifiedRatioBp ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-muted">
                  {t("cash.certificateCollectionRate")}
                </p>
                <p className="mt-1 font-semibold tnum">
                  {fmt.percent(fin?.collectionRatioBp ?? 0)}
                </p>
              </div>
            </div>
          )}
          {project.description && (
            <p className="mt-4 border-t border-border-subtle pt-4 text-sm leading-6 text-muted">
              {project.description}
            </p>
          )}
        </Card>

        {showFinancials ? (
          <Card className="p-4">
            <SectionHeader title={t("projects.attention")} />
            {Object.values(attention).every((count) => count === 0) ? (
              <EmptyState
                icon={CircleAlert}
                title={t("notifications.empty")}
                className="!py-7"
              />
            ) : (
              <div className="divide-y divide-border-subtle">
                <AttentionRow
                  label={t("dashboard.attention.overdue")}
                  count={attention.overdueCertificates}
                  onClick={() => onNavigate("finance", "receivables")}
                />
                <AttentionRow
                  label={t("dashboard.attention.ready")}
                  count={attention.readyToInvoice}
                  onClick={() => onNavigate("contracts")}
                />
                <AttentionRow
                  label={t("dashboard.attention.unallocated")}
                  count={attention.unallocatedPayments}
                  onClick={() => onNavigate("finance", "payments")}
                />
                <AttentionRow
                  label={t("dashboard.attention.team")}
                  count={attention.teamPaymentsDue}
                  onClick={() => onNavigate("team")}
                />
              </div>
            )}
          </Card>
        ) : (
          <RecentProjectActivity
            records={activity}
            onOpen={onOpenActivity}
          />
        )}
      </div>

      {showFinancials && (
        <RecentProjectActivity records={activity} onOpen={onOpenActivity} />
      )}

      <section>
        <SectionHeader title={t("stages.title")} />
        <StagesTab projectId={project.id} />
      </section>
    </div>
  );
}

export function ProjectMetric({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <Card className="p-4" variant="summary">
      <p className="text-xs font-medium text-muted">{label}</p>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <p
          className={cx(
            "text-xl font-semibold tracking-tight tnum",
            tone === "success" && "text-emerald-600 dark:text-emerald-400",
            tone === "warning" && "text-amber-600 dark:text-amber-400",
            tone === "danger" && "text-red-600 dark:text-red-400",
          )}
        >
          {value}
        </p>
        {hint && <span className="text-xs text-muted tnum">{hint}</span>}
      </div>
    </Card>
  );
}

export function AttentionRow({
  label,
  count,
  onClick,
}: {
  label: string;
  count: number;
  onClick: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      className="flex w-full items-center justify-between gap-3 py-3 text-start text-sm hover:text-brand-600"
      onClick={onClick}
    >
      <span>{label}</span>
      <Badge label={String(count)} tone="warning" />
    </button>
  );
}

export function RecentProjectActivity({
  records,
  onOpen,
}: {
  records: AuditRecord[];
  onOpen: (record: AuditRecord) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  return (
    <Card className="p-4">
      <SectionHeader title={t("dashboard.recentActivity")} />
      {records.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={t("projects.noRecentActivity")}
          className="!py-7"
        />
      ) : (
        <div className="divide-y divide-border-subtle">
          {records.map((record) => (
            <button
              key={record.id}
              className="flex w-full items-center gap-3 py-2.5 text-start hover:text-brand-600"
              onClick={() => onOpen(record)}
            >
              <span className="rounded-full bg-surface-subtle p-2 text-muted">
                <Activity size={14} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {t("dashboard.activityLine", {
                    action: t(
                      ACTIVITY_ACTION_KEYS[record.action] ??
                        "dashboard.activityActions.other",
                    ),
                    entity: t(
                      ACTIVITY_ENTITY_KEYS[record.entityType] ??
                        "dashboard.activityEntities.record",
                    ),
                  })}
                </span>
                <span className="mt-0.5 block text-xs text-muted tnum">
                  {fmt.date(record.timestamp.slice(0, 10))}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

