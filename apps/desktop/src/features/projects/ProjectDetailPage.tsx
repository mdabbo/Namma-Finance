import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Archive, ArrowLeft, ArrowRight, Pencil, Plus } from "lucide-react";
import type { Contract } from "@mep/core";
import { contractCascadeInfo, useContractMutations, useContractsByProject } from "../../repositories/contracts";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useExpensesByProject } from "../../repositories/expenses";
import { useAssignmentsByProject } from "../../repositories/people";
import { useProject, useProjectMutations } from "../../repositories/projects";
import { projectCascadeInfo } from "../../repositories/projects";
import { usePaymentsByProject } from "../../repositories/payments";
import { useProjectAuditRecords, type AuditRecord } from "../../repositories/audit";
import { Badge, Button, EmptyState, PageHeader, cx } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useRole } from "../../lib/roles";
import { ContractForm } from "./ContractForm";
import { ProjectForm } from "./ProjectForm";
import { DocumentsTab } from "./DocumentsTab";
import { parseProjectWorkspaceLocation, projectActivityDestination, projectTabsForRole, type ProjectFinanceView, type ProjectWorkspaceTab } from "./projectWorkspaceModel";
import { ProjectSummary } from "./ProjectSummaryTab";
import { ProjectContracts } from "./ProjectContractsTab";
import { ProjectFinance } from "./ProjectFinanceTab";
import { ProjectTeam, ProjectTeamForm } from "./ProjectTeamTab";
import { ProjectTime } from "./ProjectTimeTab";

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

  const [searchParams, setSearchParams] = useSearchParams();
  const [contractModal, setContractModal] = useState<Contract | "new" | null>(
    null,
  );
  const [editingProject, setEditingProject] = useState(false);
  const [deletingProject, setDeletingProject] = useState<{
    details: string[];
  } | null>(null);
  const [deletingContract, setDeletingContract] = useState<{
    contract: Contract;
    details: string[];
  } | null>(null);
  const [addingMember, setAddingMember] = useState(false);

  if (!project) return <EmptyState message={t("common.loading")} />;

  const visibleTabs = projectTabsForRole(role);
  // The URL owns where the workspace is, so refresh, back/forward and a pasted
  // link all land in the same place. An unknown or forbidden tab falls back.
  const { tab: activeTab, financeView } = parseProjectWorkspaceLocation(searchParams, role);
  const BackIcon = i18n.dir() === "rtl" ? ArrowRight : ArrowLeft;

  function goTo(nextTab: ProjectWorkspaceTab, nextFinanceView?: ProjectFinanceView) {
    if (!visibleTabs.includes(nextTab)) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", nextTab);
    if (nextTab === "finance") next.set("view", nextFinanceView ?? financeView);
    else next.delete("view");
    // A tab change is a place the user can go back from.
    setSearchParams(next);
  }

  function openActivity(record: AuditRecord) {
    const destination = projectActivityDestination(record.entityType);
    goTo(destination.tab, destination.financeView);
  }

  function contractHasFinancialHistory(contractId: number): boolean {
    const state = financials?.contractStates.get(contractId);
    return (state?.certificates.some((row) => row.certificate.status !== "DRAFT") ?? false)
      || payments.some((payment) => payment.contractId === contractId);
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
              <Button
                onClick={async () => {
                  const info = await projectCascadeInfo(project.id);
                  setDeletingProject({
                    details: [
                      `${info.contracts} ${t("contracts.title")}`,
                      `${info.certificates} ${t("certificates.title")}`,
                      `${info.payments} ${t("payments.title")}`,
                      `${info.expenses} ${t("expenses.title")}`,
                    ],
                  });
                }}
              >
                <Archive size={15} aria-hidden="true" />
                {t("lifecycle.archiveProject")}
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
            onClick={() => goTo(key)}
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
          onNavigate={goTo}
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
          onViewChange={(view) => goTo("finance", view)}
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
          onClose={() => {
            projectMutations.update.reset();
            setEditingProject(false);
          }}
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
          hasFinancialHistory={contractModal !== "new" && contractModal !== null ? contractHasFinancialHistory(contractModal.id) : false}
          error={
            contractMutations.create.isError
              ? (contractMutations.create.error as Error).message
              : contractMutations.update.isError
                ? (contractMutations.update.error as Error).message
                : undefined
          }
          busy={
            contractMutations.create.isPending ||
            contractMutations.update.isPending
          }
          onClose={() => {
            contractMutations.create.reset();
            contractMutations.update.reset();
            setContractModal(null);
          }}
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

      {deletingProject && (
        <ConfirmDialog
          title={t("lifecycle.archiveProject")}
          tone="neutral"
          confirmLabel={t("lifecycle.archive")}
          requireReason
          message={`${t("lifecycle.confirmArchiveProject")} (${project.name})`}
          details={deletingProject.details}
          busy={projectMutations.remove.isPending}
          onCancel={() => {
            projectMutations.remove.reset();
            setDeletingProject(null);
          }}
          onConfirm={(reason) =>
            projectMutations.remove.mutate(
              { id: project.id, reason },
              {
                onSuccess: () => {
                  setDeletingProject(null);
                  navigate("/projects");
                },
              },
            )
          }
        />
      )}

      {deletingContract && (
        <ConfirmDialog
          title={t("lifecycle.archiveContract")}
          tone="neutral"
          confirmLabel={t("lifecycle.archive")}
          message={`${t("lifecycle.confirmArchiveContract")} (${deletingContract.contract.number})`}
          details={deletingContract.details}
          busy={contractMutations.remove.isPending}
          onCancel={() => {
            contractMutations.remove.reset();
            setDeletingContract(null);
          }}
          onConfirm={() =>
            contractMutations.remove.mutate({ id: deletingContract.contract.id }, {
              onSuccess: () => setDeletingContract(null),
            })
          }
        />
      )}
    </div>
  );
}
