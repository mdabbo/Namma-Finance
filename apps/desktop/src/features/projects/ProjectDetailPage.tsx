import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Clock3,
  Pencil,
  Plus,
  ReceiptText,
  Users,
} from "lucide-react";
import type { AssignmentLifecycle, CertificateStatus, Contract } from "@mep/core";
import {
  assignmentSchema,
  laborCostMinor,
  minutesToHours,
  type AssignmentInput,
} from "@mep/core";
import {
  contractCascadeInfo,
  useContractMutations,
  useContractRevisions,
  useContractsByProject,
} from "../../repositories/contracts";
import {
  useWorkspaceFinancials,
  type WorkspaceFinancials,
} from "../../repositories/financials";
import {
  useExpensesByProject,
  type ExpenseListItem,
} from "../../repositories/expenses";
import {
  useAssignmentsByProject,
  usePeople,
  usePeopleMutations,
  type AssignmentListItem,
} from "../../repositories/people";
import {
  useProject,
  useProjectMutations,
  type ProjectListItem,
} from "../../repositories/projects";
import {
  usePaymentsByProject,
  type PaymentListItem,
} from "../../repositories/payments";
import {
  useProjectAuditRecords,
  type AuditRecord,
} from "../../repositories/audit";
import {
  useTimeEntriesByProject,
  useTimeEntryMutations,
  type TimeEntryListItem,
} from "../../repositories/timeEntries";
import { DataTable, type Column } from "../../components/DataTable";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  RatioBar,
  SectionHeader,
  Select,
  cx,
} from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { MoneyInput } from "../../components/MoneyInput";
import { useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import { useRole } from "../../lib/roles";
import { ContractForm } from "./ContractForm";
import { ProjectForm } from "./ProjectForm";
import { PersonForm } from "../people/PeoplePage";
import { StagesTab } from "./StagesTab";
import { DocumentsTab } from "./DocumentsTab";
import { TimeEntryForm } from "../time/TimePage";
import {
  PROJECT_FINANCE_VIEWS,
  projectActivityDestination,
  projectAttentionSummary,
  projectTabsForRole,
  readModelAmount,
  UNKNOWN_AMOUNT,
  type ProjectFinanceView,
  type ProjectWorkspaceTab,
} from "./projectWorkspaceModel";

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

export function ProjectDetailPage() {
  const { id } = useParams();
  const projectId = Number(id);
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const role = useRole();

  const { data: project } = useProject(projectId);
  const { data: contracts = [] } = useContractsByProject(projectId);
  const { data: financials, isPending: financialsPending } = useWorkspaceFinancials();
  const { data: expenses = [] } = useExpensesByProject(projectId);
  const { data: assignments = [] } = useAssignmentsByProject(projectId);
  const { data: payments = [] } = usePaymentsByProject(projectId);
  const recentActivity = useProjectAuditRecords(projectId, 8, role === "ENGINEER");
  const contractMutations = useContractMutations();
  const projectMutations = useProjectMutations();

  const [tab, setTab] = useState<ProjectWorkspaceTab>("summary");
  const [financeView, setFinanceView] =
    useState<ProjectFinanceView>("certificates");
  const [contractModal, setContractModal] = useState<Contract | "new" | null>(
    null,
  );
  const [editingProject, setEditingProject] = useState(false);
  const [deletingContract, setDeletingContract] = useState<{
    contract: Contract;
    details: string[];
  } | null>(null);
  const [addingMember, setAddingMember] = useState(false);

  if (!project) return <EmptyState message={t("common.loading")} />;

  const visibleTabs = projectTabsForRole(role);
  const activeTab = visibleTabs.includes(tab) ? tab : visibleTabs[0]!;
  const BackIcon = i18n.dir() === "rtl" ? ArrowRight : ArrowLeft;

  function openActivity(record: AuditRecord) {
    const destination = projectActivityDestination(record.entityType);
    if (!visibleTabs.includes(destination.tab)) return;
    setTab(destination.tab);
    if (destination.financeView) setFinanceView(destination.financeView);
  }

  return (
    <div>
      <button
        onClick={() => navigate("/projects")}
        className="mb-3 flex items-center gap-1 text-sm text-muted hover:text-brand-600"
      >
        <BackIcon size={15} aria-hidden="true" />
        {t("projects.title")}
      </button>

      <PageHeader
        title={project.name}
        meta={<Badge value={project.status} label={t(`status.${project.status}`)} />}
        description={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tnum">{project.code}</span>
            <span aria-hidden="true">·</span>
            <span>{project.clientName}</span>
            {project.manager && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {t("projects.manager")}: {project.manager}
                </span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>{t(`discipline.${project.discipline}`)}</span>
            <Badge label={project.currency} tone="info" />
          </div>
        }
        actions={
          role !== "ENGINEER" && (
            <>
              <Button onClick={() => setEditingProject(true)}>
                <Pencil size={15} aria-hidden="true" />
                {t("projects.editProject")}
              </Button>
              <Button variant="primary" onClick={() => setContractModal("new")}>
                <Plus size={15} aria-hidden="true" />
                {t("contracts.newContract")}
              </Button>
            </>
          )
        }
      />

      <div
        className="mb-5 flex gap-1 overflow-x-auto border-b border-border-subtle"
        role="tablist"
        aria-label={t("projects.workspaceTabs")}
      >
        {visibleTabs.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={activeTab === key}
            onClick={() => setTab(key)}
            className={cx(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              activeTab === key
                ? "border-brand-600 text-brand-700 dark:text-brand-300"
                : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {t(`projects.workspace.${key}`)}
          </button>
        ))}
      </div>

      {activeTab === "summary" && (
        <ProjectSummary
          project={project}
          financials={financials}
          activity={recentActivity.data ?? []}
          showFinancials={role !== "ENGINEER"}
          onNavigate={(nextTab, nextFinanceView) => {
            setTab(nextTab);
            if (nextFinanceView) setFinanceView(nextFinanceView);
          }}
          onOpenActivity={openActivity}
        />
      )}

      {activeTab === "contracts" && role !== "ENGINEER" && (
        <ProjectContracts
          contracts={contracts}
          financials={financials}
          currency={project.currency}
          onCreate={() => setContractModal("new")}
          onEdit={setContractModal}
          onDelete={async (contract) => {
            const info = await contractCascadeInfo(contract.id);
            setDeletingContract({
              contract,
              details: [
                `${info.certificates} ${t("certificates.title")}`,
                `${info.payments} ${t("payments.title")}`,
              ],
            });
          }}
        />
      )}

      {activeTab === "finance" && role !== "ENGINEER" && (
        <ProjectFinance
          projectId={projectId}
          projectCurrency={project.currency}
          financials={financials}
          financialsPending={financialsPending}
          expenses={expenses}
          payments={payments}
          activeView={financeView}
          onViewChange={setFinanceView}
        />
      )}

      {activeTab === "team" && role !== "ENGINEER" && (
        <ProjectTeam
          assignments={assignments}
          financials={financials}
          financialsPending={financialsPending}
          onAdd={() => setAddingMember(true)}
        />
      )}

      {activeTab === "time" && <ProjectTime projectId={projectId} />}
      {activeTab === "documents" && <DocumentsTab projectId={projectId} />}

      {addingMember && (
        <ProjectTeamForm
          projectId={projectId}
          currency={project.currency}
          fxRateMicro={project.fxRateMicro}
          onClose={() => setAddingMember(false)}
        />
      )}

      {editingProject && (
        <ProjectForm
          initial={project}
          busy={projectMutations.update.isPending}
          onClose={() => setEditingProject(false)}
          onSubmit={(input, revision) =>
            projectMutations.update.mutate(
              { id: project.id, input, revision },
              { onSuccess: () => setEditingProject(false) },
            )
          }
        />
      )}

      {contractModal !== null && (
        <ContractForm
          projectId={projectId}
          currency={project.currency}
          initial={contractModal === "new" ? null : contractModal}
          busy={
            contractMutations.create.isPending ||
            contractMutations.update.isPending
          }
          onClose={() => setContractModal(null)}
          onSubmit={(input, revision) => {
            if (contractModal === "new") {
              contractMutations.create.mutate(input, {
                onSuccess: () => setContractModal(null),
              });
            } else {
              contractMutations.update.mutate(
                { id: contractModal.id, input, revision },
                { onSuccess: () => setContractModal(null) },
              );
            }
          }}
        />
      )}

      {deletingContract && (
        <ConfirmDialog
          message={`${t("common.confirmDeleteMessage")} ${deletingContract.contract.number}`}
          details={deletingContract.details}
          busy={contractMutations.remove.isPending}
          onCancel={() => setDeletingContract(null)}
          onConfirm={() =>
            contractMutations.remove.mutate(deletingContract.contract.id, {
              onSuccess: () => setDeletingContract(null),
            })
          }
        />
      )}
    </div>
  );
}

function ProjectSummary({
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

function ProjectMetric({
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

function AttentionRow({
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

function RecentProjectActivity({
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

function ProjectContracts({
  contracts,
  financials,
  currency,
  onCreate,
  onEdit,
  onDelete,
}: {
  contracts: Contract[];
  financials: WorkspaceFinancials | undefined;
  currency: string;
  onCreate: () => void;
  onEdit: (contract: Contract) => void;
  onDelete: (contract: Contract) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const columns: Column<Contract>[] = [
    {
      key: "number",
      header: t("contracts.number"),
      value: (contract) => contract.number,
      render: (contract) => (
        <div>
          <p className="font-medium tnum">{contract.number}</p>
          {contract.title && (
            <p className="mt-0.5 text-xs text-muted">{contract.title}</p>
          )}
        </div>
      ),
    },
    {
      key: "basis",
      header: t("contracts.valuationMode"),
      value: (contract) => contract.valuationMode,
      render: (contract) =>
        t(
          contract.valuationMode === "MILESTONES"
            ? "contracts.milestonesMode"
            : contract.valuationMode === "DRAWINGS"
              ? "contracts.drawingsMode"
              : "contracts.lumpSum",
        ),
    },
    {
      key: "value",
      header: t("contracts.value"),
      value: (contract) => contract.valueMinor,
      render: (contract) =>
        fmt.money(contract.valueMinor, currency, { compactFraction: true }),
      align: "end",
    },
    {
      key: "certified",
      header: t("cash.certifiedRevenue"),
      value: (contract) =>
        financials?.contractStates.get(contract.id)?.certifiedBaseMinor ?? 0,
      render: (contract) =>
        fmt.money(
          financials?.contractStates.get(contract.id)?.certifiedBaseMinor ?? 0,
          currency,
          { compactFraction: true },
        ),
      align: "end",
    },
    {
      key: "outstanding",
      header: t("cash.outstandingReceivables"),
      value: (contract) =>
        financials?.contractStates.get(contract.id)?.outstandingReceivablesMinor ??
        0,
      render: (contract) =>
        fmt.money(
          financials?.contractStates.get(contract.id)
            ?.outstandingReceivablesMinor ?? 0,
          currency,
          { compactFraction: true },
        ),
      align: "end",
    },
    {
      key: "collection",
      header: t("cash.certificateCollectionRate"),
      value: (contract) =>
        financials?.contractStates.get(contract.id)?.collectionRatioBp ?? 0,
      render: (contract) =>
        fmt.percent(
          financials?.contractStates.get(contract.id)?.collectionRatioBp ?? 0,
        ),
      align: "end",
    },
    {
      key: "history",
      header: t("contracts.revisionHistory"),
      sortable: false,
      render: (contract) => (
        <ContractRevisionHistory contractId={contract.id} />
      ),
    },
    {
      key: "actions",
      header: t("common.actions"),
      sortable: false,
      render: (contract) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => onEdit(contract)}>
            {t("common.edit")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="!text-red-600"
            onClick={() => onDelete(contract)}
          >
            {t("common.delete")}
          </Button>
        </div>
      ),
      align: "end",
    },
  ];

  return (
    <section>
      <SectionHeader
        title={t("contracts.title")}
        actions={
          <Button variant="primary" onClick={onCreate}>
            <Plus size={15} aria-hidden="true" />
            {t("contracts.newContract")}
          </Button>
        }
      />
      {contracts.length === 0 ? (
        <Card>
          <EmptyState
            icon={ReceiptText}
            title={t("projects.emptyContracts")}
            description={t("projects.emptyContractsHint")}
            action={
              <Button variant="primary" onClick={onCreate}>
                <Plus size={15} aria-hidden="true" />
                {t("contracts.newContract")}
              </Button>
            }
          />
        </Card>
      ) : (
        <DataTable
          rows={contracts}
          columns={columns}
          rowKey={(contract) => contract.id}
          density="compact"
          initialSort={{ key: "number", dir: "asc" }}
        />
      )}
    </section>
  );
}

function ContractRevisionHistory({ contractId }: { contractId: number }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: revisions = [] } = useContractRevisions(contractId);
  if (revisions.length === 0) return <span className="text-muted">—</span>;
  const current = revisions[revisions.length - 1]!;
  return (
    <details className="min-w-40 text-xs">
      <summary className="cursor-pointer font-medium text-muted hover:text-brand-600">
        {t("projects.currentRevision", {
          revision: current.revisionNumber,
          count: revisions.length,
        })}
      </summary>
      <div className="mt-2 space-y-2">
        {revisions.map((revision) => (
          <div
            key={revision.id}
            className="rounded-[var(--radius-control)] bg-surface-subtle p-2"
          >
            <div className="flex justify-between gap-3">
              <span className="font-medium tnum">
                #{revision.revisionNumber}
              </span>
              <span className="tnum">{fmt.date(revision.effectiveDate)}</span>
            </div>
            <p className="mt-1 font-medium tnum">
              {fmt.money(revision.contractValueMinor, revision.currency, {
                compactFraction: true,
              })}
            </p>
            <p className="mt-1 truncate text-muted" title={revision.reason}>
              {revision.reason}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}

function ProjectFinance({
  projectId,
  projectCurrency,
  financials,
  financialsPending,
  expenses,
  payments,
  activeView,
  onViewChange,
}: {
  projectId: number;
  projectCurrency: string;
  financials: WorkspaceFinancials | undefined;
  financialsPending: boolean;
  expenses: ExpenseListItem[];
  payments: PaymentListItem[];
  activeView: ProjectFinanceView;
  onViewChange: (view: ProjectFinanceView) => void;
}) {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const navigate = useNavigate();
  const [certificateStatus, setCertificateStatus] = useState<
    CertificateStatus | ""
  >("");
  const [paymentKind, setPaymentKind] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("");

  const states = [
    ...(financials?.contractStates.values() ?? []),
  ].filter((state) => state.contract.projectId === projectId);
  const certificates = states.flatMap((state) =>
    state.certificates.map((certificate) => ({
      ...certificate,
      contractNumber: state.contract.number,
    })),
  );
  const visibleCertificates = certificates.filter(
    (row) =>
      !certificateStatus || row.certificate.status === certificateStatus,
  );
  const visiblePayments = payments.filter(
    (payment) => !paymentKind || payment.kind === paymentKind,
  );
  const categories = Array.from(
    new Map(
      expenses.map((expense) => [
        String(expense.categoryId),
        i18n.language === "ar" ? expense.categoryAr : expense.categoryEn,
      ]),
    ),
  );
  const visibleExpenses = expenses.filter(
    (expense) =>
      !expenseCategory || String(expense.categoryId) === expenseCategory,
  );
  const receivables = certificates.filter(
    (row) =>
      row.certificate.status !== "DRAFT" && row.unpaidMinor > 0,
  );

  const certificateColumns: Column<(typeof certificates)[number]>[] = [
    {
      key: "number",
      header: t("certificates.number"),
      value: (row) => row.certificate.number,
      render: (row) => (
        <span className="font-medium tnum">{row.certificate.number}</span>
      ),
    },
    {
      key: "contract",
      header: t("certificates.contract"),
      value: (row) => row.contractNumber,
      render: (row) => <span className="tnum">{row.contractNumber}</span>,
    },
    {
      key: "date",
      header: t("common.date"),
      value: (row) => row.certificate.date,
      render: (row) => fmt.date(row.certificate.date),
    },
    {
      key: "gross",
      header: t("certificates.gross"),
      value: (row) => row.breakdown.grossMinor,
      render: (row) =>
        fmt.money(
          row.breakdown.grossMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "net",
      header: t("certificates.netPayable"),
      value: (row) => row.breakdown.netPayableMinor,
      render: (row) =>
        fmt.money(
          row.breakdown.netPayableMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "paid",
      header: t("certificates.paid"),
      value: (row) => row.paidMinor,
      render: (row) =>
        fmt.money(
          row.paidMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "status",
      header: t("common.status"),
      value: (row) => row.certificate.status,
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <Badge
            value={row.certificate.status}
            label={t(`status.${row.certificate.status}`)}
          />
          {row.overdue && (
            <Badge
              value="OVERDUE"
              label={t("certificates.overdue")}
            />
          )}
        </div>
      ),
    },
  ];

  const paymentColumns: Column<PaymentListItem>[] = [
    {
      key: "number",
      header: t("payments.number"),
      value: (payment) => payment.number,
      render: (payment) => (
        <span className="font-medium tnum">{payment.number}</span>
      ),
    },
    {
      key: "date",
      header: t("common.date"),
      value: (payment) => payment.date,
      render: (payment) => fmt.date(payment.date),
    },
    {
      key: "contract",
      header: t("certificates.contract"),
      value: (payment) => payment.contractNumber,
      render: (payment) => (
        <span className="tnum">{payment.contractNumber}</span>
      ),
    },
    {
      key: "kind",
      header: t("payments.kind"),
      value: (payment) => payment.kind,
      render: (payment) => t(`paymentKind.${payment.kind}`),
    },
    {
      key: "method",
      header: t("payments.method"),
      value: (payment) => payment.method,
      render: (payment) => t(`method.${payment.method}`),
    },
    {
      key: "amount",
      header: t("common.amount"),
      value: (payment) =>
        financials?.cashIn.find((item) => item.paymentId === payment.id)
          ?.egpMinor ?? 0,
      // Never print a zero the read model did not produce: until the audited
      // snapshot resolves, the consolidated amount is unknown, not nil.
      render: (payment) =>
        readModelAmount(
          financials?.cashIn.find((item) => item.paymentId === payment.id),
          (cash) => base.format(cash.egpMinor),
        ),
      align: "end",
    },
  ];

  const expenseColumns: Column<ExpenseListItem>[] = [
    {
      key: "number",
      header: t("expenses.number"),
      value: (expense) => expense.number,
      render: (expense) => (
        <span className="font-medium tnum">{expense.number}</span>
      ),
    },
    {
      key: "date",
      header: t("common.date"),
      value: (expense) => expense.date,
      render: (expense) => fmt.date(expense.date),
    },
    {
      key: "category",
      header: t("expenses.category"),
      value: (expense) =>
        i18n.language === "ar" ? expense.categoryAr : expense.categoryEn,
    },
    {
      key: "description",
      header: t("common.description"),
      value: (expense) => expense.description,
    },
    {
      key: "supplier",
      header: t("expenses.supplier"),
      value: (expense) => expense.supplier,
    },
    {
      key: "amount",
      header: t("common.amount"),
      value: (expense) => expense.amountMinor,
      render: (expense) =>
        fmt.money(expense.amountMinor, expense.currency),
      align: "end",
    },
  ];

  const receivableColumns: Column<(typeof receivables)[number]>[] = [
    {
      key: "number",
      header: t("certificates.number"),
      value: (row) => row.certificate.number,
      render: (row) => (
        <span className="font-medium tnum">{row.certificate.number}</span>
      ),
    },
    {
      key: "contract",
      header: t("certificates.contract"),
      value: (row) => row.contractNumber,
      render: (row) => <span className="tnum">{row.contractNumber}</span>,
    },
    {
      key: "due",
      header: t("certificates.dueDate"),
      value: (row) => row.dueDate,
      render: (row) => fmt.date(row.dueDate),
    },
    {
      key: "net",
      header: t("certificates.netPayable"),
      value: (row) => row.breakdown.netPayableMinor,
      render: (row) =>
        fmt.money(
          row.breakdown.netPayableMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "unpaid",
      header: t("certificates.unpaid"),
      value: (row) => row.unpaidMinor,
      render: (row) =>
        fmt.money(
          row.unpaidMinor,
          row.certificate.currencySnapshot ?? projectCurrency,
        ),
      align: "end",
    },
    {
      key: "status",
      header: t("common.status"),
      value: (row) => (row.overdue ? "OVERDUE" : row.certificate.status),
      render: (row) => (
        <Badge
          value={row.overdue ? "OVERDUE" : row.certificate.status}
          label={
            row.overdue
              ? t("certificates.overdue")
              : t(`status.${row.certificate.status}`)
          }
        />
      ),
    },
  ];

  const destination = {
    certificates: "/finance/certificates",
    payments: "/finance/payments",
    expenses: "/finance/expenses",
    receivables: "/finance/receivables",
  }[activeView];

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex rounded-[var(--radius-control)] bg-surface-subtle p-1"
          role="tablist"
          aria-label={t("projects.financeSections")}
        >
          {PROJECT_FINANCE_VIEWS.map((view) => (
            <button
              key={view}
              role="tab"
              aria-selected={activeView === view}
              className={cx(
                "rounded-[calc(var(--radius-control)-2px)] px-3 py-1.5 text-xs font-medium",
                activeView === view
                  ? "bg-surface text-foreground shadow-sm"
                  : "text-muted hover:text-foreground",
              )}
              onClick={() => onViewChange(view)}
            >
              {t(`projects.financeViews.${view}`)}
            </button>
          ))}
        </div>
        <Button
          variant="primary"
          onClick={() =>
            navigate(
              `${destination}${destination.includes("?") ? "&" : "?"}projectId=${projectId}`,
            )
          }
        >
          <Plus size={15} aria-hidden="true" />
          {t(`projects.financeActions.${activeView}`)}
        </Button>
      </div>

      {activeView === "certificates" && (
        <DataTable
          rows={visibleCertificates}
          columns={certificateColumns}
          rowKey={(row) => row.certificate.id}
          density="compact"
          loading={financialsPending}
          onRowClick={() => navigate("/finance/certificates")}
          toolbar={
            <Select
              className="!w-44"
              value={certificateStatus}
              onChange={(event) =>
                setCertificateStatus(
                  event.target.value as CertificateStatus | "",
                )
              }
            >
              <option value="">
                {t("common.status")}: {t("common.all")}
              </option>
              {(["DRAFT", "SUBMITTED", "APPROVED", "PAID"] as const).map(
                (status) => (
                  <option key={status} value={status}>
                    {t(`status.${status}`)}
                  </option>
                ),
              )}
            </Select>
          }
          emptyMessage={t("projects.emptyCertificates")}
        />
      )}

      {activeView === "payments" && (
        <DataTable
          rows={visiblePayments}
          columns={paymentColumns}
          rowKey={(payment) => payment.id}
          density="compact"
          onRowClick={() => navigate("/finance/payments")}
          toolbar={
            <Select
              className="!w-44"
              value={paymentKind}
              onChange={(event) => setPaymentKind(event.target.value)}
            >
              <option value="">
                {t("payments.kind")}: {t("common.all")}
              </option>
              {(["CERTIFICATE", "ADVANCE", "RETENTION_RELEASE"] as const).map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {t(`paymentKind.${kind}`)}
                  </option>
                ),
              )}
            </Select>
          }
          emptyMessage={t("projects.emptyPayments")}
        />
      )}

      {activeView === "expenses" && (
        <DataTable
          rows={visibleExpenses}
          columns={expenseColumns}
          rowKey={(expense) => expense.id}
          density="compact"
          onRowClick={() => navigate("/finance/expenses")}
          toolbar={
            <Select
              className="!w-48"
              value={expenseCategory}
              onChange={(event) => setExpenseCategory(event.target.value)}
            >
              <option value="">
                {t("expenses.category")}: {t("common.all")}
              </option>
              {categories.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          }
          emptyMessage={t("projects.emptyExpenses")}
        />
      )}

      {activeView === "receivables" && (
        <DataTable
          rows={receivables}
          columns={receivableColumns}
          rowKey={(row) => row.certificate.id}
          density="compact"
          loading={financialsPending}
          onRowClick={() => navigate(`/finance/receivables?projectId=${projectId}`)}
          emptyMessage={t("projects.emptyReceivables")}
        />
      )}
    </section>
  );
}

function ProjectTeam({
  assignments,
  financials,
  financialsPending,
  onAdd,
}: {
  assignments: AssignmentListItem[];
  financials: WorkspaceFinancials | undefined;
  financialsPending: boolean;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const navigate = useNavigate();
  const mutations = usePeopleMutations();
  const [cancelling, setCancelling] = useState<AssignmentListItem | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const accountOf = (assignmentId: number) =>
    financials?.teamAccounts.find(
      (account) => account.assignmentId === assignmentId,
    );
  const columns: Column<AssignmentListItem>[] = [
    {
      key: "person",
      header: t("time.person"),
      value: (assignment) => assignment.personName,
      render: (assignment) => (
        <span className="font-medium">{assignment.personName}</span>
      ),
    },
    {
      key: "scope",
      header: t("common.description"),
      value: (assignment) => assignment.scope,
    },
    {
      // Lifecycle answers what happened to the work; archiving is separate, so
      // an archived row still shows the lifecycle that governs its money.
      key: "lifecycle",
      header: t("common.status"),
      value: (assignment) => assignment.lifecycleStatus,
      render: (assignment) => (
        <div className="flex items-center gap-1.5">
          <Badge
            value={ASSIGNMENT_LIFECYCLE_TONE[assignment.lifecycleStatus]}
            label={t(`assignments.lifecycle.${assignment.lifecycleStatus}`)}
          />
          {assignment.archivedAt !== null && (
            <Badge value="CANCELLED" label={t("lifecycle.archived")} />
          )}
        </div>
      ),
    },
    {
      key: "agreed",
      header: t("people.agreedAmount"),
      value: (assignment) => assignment.agreedMinor,
      render: (assignment) =>
        fmt.money(assignment.agreedMinor, assignment.currency, {
          compactFraction: true,
        }),
      align: "end",
    },
    // Payout figures belong to the audited read model. Until it resolves,
    // these columns show "unknown", never a fabricated zero balance.
    {
      key: "accrued",
      header: t("projects.teamAccrued"),
      value: (assignment) =>
        accountOf(assignment.id)?.accruedMinor ?? 0,
      render: (assignment) =>
        readModelAmount(accountOf(assignment.id), (account) =>
          fmt.money(account.accruedMinor, assignment.currency, {
            compactFraction: true,
          })),
      align: "end",
    },
    {
      key: "paid",
      header: t("people.paidToDate"),
      value: (assignment) => accountOf(assignment.id)?.paidMinor ?? 0,
      render: (assignment) =>
        readModelAmount(accountOf(assignment.id), (account) =>
          fmt.money(account.paidMinor, assignment.currency, {
            compactFraction: true,
          })),
      align: "end",
    },
    {
      key: "due",
      header: t("team.dueNow"),
      value: (assignment) => accountOf(assignment.id)?.dueMinor ?? 0,
      render: (assignment) => {
        const account = accountOf(assignment.id);
        if (!account) return <span className="text-muted">{UNKNOWN_AMOUNT}</span>;
        return account.dueMinor > 0 ? (
          <Badge
            tone="warning"
            label={fmt.money(account.dueMinor, assignment.currency, {
              compactFraction: true,
            })}
          />
        ) : (
          <span className="text-muted tnum">
            {fmt.money(0, assignment.currency, { compactFraction: true })}
          </span>
        );
      },
      align: "end",
    },
    {
      key: "lifecycleActions",
      header: "",
      sortable: false,
      width: "210px",
      render: (assignment) =>
        assignment.lifecycleStatus === "ACTIVE" ? (
          <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
            <Button
              variant="ghost"
              disabled={mutations.completeAssignment.isPending}
              onClick={() => mutations.completeAssignment.mutate(assignment.id)}
            >
              {t("assignments.complete")}
            </Button>
            <Button
              variant="ghost"
              className="!text-red-600"
              onClick={() => setCancelling(assignment)}
            >
              {t("assignments.cancel")}
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <section>
      <SectionHeader
        title={t("projects.team")}
        actions={
          <Button variant="primary" onClick={onAdd}>
            <Plus size={15} aria-hidden="true" />
            {t("projects.addTeamMember")}
          </Button>
        }
      />
      {assignments.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={t("projects.emptyTeam")}
            description={t("projects.emptyTeamHint")}
            action={
              <Button variant="primary" onClick={onAdd}>
                <Plus size={15} aria-hidden="true" />
                {t("projects.addTeamMember")}
              </Button>
            }
          />
        </Card>
      ) : (
        <DataTable
          rows={assignments}
          columns={columns}
          rowKey={(assignment) => assignment.id}
          density="compact"
          loading={financialsPending}
          onRowClick={(assignment) =>
            navigate(`/team/people/${assignment.personId}`)
          }
        />
      )}

      {/* Cancelling drops the unearned commitment, so it records why. */}
      {cancelling && (
        <Modal title={t("assignments.cancelTitle")} onClose={() => setCancelling(null)}>
          <p className="mb-4 text-sm leading-6 text-muted">
            {t("assignments.cancelExplain", { person: cancelling.personName })}
          </p>
          <Field label={t("assignments.cancelReason")}>
            <Input
              autoFocus
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
            />
          </Field>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setCancelling(null)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              className="!bg-red-600 hover:!bg-red-700"
              disabled={!cancelReason.trim() || mutations.cancelAssignment.isPending}
              onClick={() =>
                mutations.cancelAssignment.mutate(
                  { id: cancelling.id, reason: cancelReason },
                  {
                    onSuccess: () => {
                      setCancelling(null);
                      setCancelReason("");
                    },
                  },
                )
              }
            >
              {t("assignments.cancel")}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Badge tone per lifecycle, reusing the shared status palette. */
const ASSIGNMENT_LIFECYCLE_TONE: Record<AssignmentLifecycle, string> = {
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

/**
 * Assign a person to this project. Creating a person here also adds that
 * person to the shared Team directory.
 */
function ProjectTeamForm({
  projectId,
  currency,
  fxRateMicro,
  onClose,
}: {
  projectId: number;
  currency: string;
  fxRateMicro: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data: people = [] } = usePeople();
  const mutations = usePeopleMutations();

  const [personId, setPersonId] = useState(0);
  const [creatingPerson, setCreatingPerson] = useState(false);
  const [agreedMinor, setAgreedMinor] = useState(0);
  const [scope, setScope] = useState("");
  const [error, setError] = useState("");

  function submit() {
    const parsed = assignmentSchema.safeParse({
      personId,
      projectId,
      agreedMinor,
      currency,
      fxRateMicro,
      scope: scope || null,
      progressNote: null,
    } satisfies AssignmentInput);
    if (!parsed.success) {
      setError(t("validation.required"));
      return;
    }
    mutations.createAssignment.mutate(parsed.data, { onSuccess: onClose });
  }

  return (
    <>
      <Modal title={t("projects.addTeamMember")} onClose={onClose}>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label={t("people.selectPerson")}
            error={personId === 0 ? error : undefined}
            className="col-span-2"
          >
            <div className="flex gap-2">
              <Select
                className="flex-1"
                value={personId}
                onChange={(event) => setPersonId(Number(event.target.value))}
              >
                <option value={0}>—</option>
                {people
                  .filter((person) => person.isActive)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name} ({t(`personType.${person.type}`)})
                    </option>
                  ))}
              </Select>
              <Button onClick={() => setCreatingPerson(true)}>
                {t("people.orCreateNew")}
              </Button>
            </div>
          </Field>
          <Field label={t("people.agreedAmount")}>
            <MoneyInput
              currency={currency}
              valueMinor={agreedMinor}
              onChange={(value) => setAgreedMinor(value ?? 0)}
            />
          </Field>
          <Field label={t("common.description")}>
            <Input
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={
              personId === 0 || mutations.createAssignment.isPending
            }
          >
            {t("common.save")}
          </Button>
        </div>
      </Modal>
      {creatingPerson && (
        <PersonForm
          initial={null}
          busy={mutations.create.isPending}
          onClose={() => setCreatingPerson(false)}
          onSubmit={(input) =>
            mutations.create.mutate(input, {
              onSuccess: (newId) => {
                setPersonId(newId);
                setCreatingPerson(false);
              },
            })
          }
        />
      )}
    </>
  );
}

function ProjectTime({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: entries = [] } = useTimeEntriesByProject(projectId);
  const mutations = useTimeEntryMutations();
  const [logging, setLogging] = useState(false);
  const totalMinutes = entries.reduce((sum, entry) => sum + entry.minutes, 0);

  const columns: Column<TimeEntryListItem>[] = [
    {
      key: "date",
      header: t("common.date"),
      value: (entry) => entry.date,
      render: (entry) => fmt.date(entry.date),
    },
    {
      key: "person",
      header: t("time.person"),
      value: (entry) => entry.personName,
    },
    {
      key: "stage",
      header: t("time.stage"),
      value: (entry) => entry.stageName,
      render: (entry) => entry.stageName ?? "—",
    },
    {
      key: "notes",
      header: t("common.notes"),
      value: (entry) => entry.note,
    },
    {
      key: "hours",
      header: t("time.hours"),
      value: (entry) => entry.minutes,
      render: (entry) =>
        `${minutesToHours(entry.minutes)}${t("time.hoursShort")}`,
      align: "end",
    },
    {
      key: "cost",
      header: t("time.laborCost"),
      value: (entry) =>
        entry.hourlyRateMinor
          ? laborCostMinor(entry.minutes, entry.hourlyRateMinor)
          : 0,
      render: (entry) =>
        entry.hourlyRateMinor
          ? fmt.money(
              laborCostMinor(entry.minutes, entry.hourlyRateMinor),
              entry.personCurrency,
            )
          : "—",
      align: "end",
    },
  ];

  return (
    <section>
      <SectionHeader
        title={t("time.title")}
        description={`${t("time.totalHours")}: ${minutesToHours(totalMinutes)}${t("time.hoursShort")}`}
        actions={
          <Button variant="primary" onClick={() => setLogging(true)}>
            <Plus size={15} aria-hidden="true" />
            {t("time.newEntry")}
          </Button>
        }
      />
      {entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={Clock3}
            title={t("projects.emptyTime")}
            description={t("projects.emptyTimeHint")}
            action={
              <Button variant="primary" onClick={() => setLogging(true)}>
                <Plus size={15} aria-hidden="true" />
                {t("time.newEntry")}
              </Button>
            }
          />
        </Card>
      ) : (
        <DataTable
          rows={entries}
          columns={columns}
          rowKey={(entry) => entry.id}
          density="compact"
          initialSort={{ key: "date", dir: "desc" }}
        />
      )}

      {logging && (
        <TimeEntryForm
          initial={null}
          lockProjectId={projectId}
          busy={mutations.create.isPending}
          onClose={() => setLogging(false)}
          onSubmit={(input) =>
            mutations.create.mutate(input, {
              onSuccess: () => setLogging(false),
            })
          }
        />
      )}
    </section>
  );
}
