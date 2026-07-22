import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { ProjectStatus } from "@mep/core";
import { useProjectMutations, useProjects, nextProjectCode, projectCascadeInfo, type ProjectListItem } from "../../repositories/projects";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useSettings } from "../../lib/settings";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Badge, Button, RatioBar, Select } from "../../components/ui";
import { useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import { ProjectForm } from "./ProjectForm";

export function ProjectsPage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const navigate = useNavigate();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: projects = [], isLoading } = useProjects(includeArchived);
  const { data: financials } = useWorkspaceFinancials();
  const { data: settings } = useSettings();
  const mutations = useProjectMutations();

  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "">("");
  const [disciplineFilter, setDisciplineFilter] = useState("");
  const [editing, setEditing] = useState<ProjectListItem | null>(null);
  const [creating, setCreating] = useState<string | null>(null); // next code
  const [deleting, setDeleting] = useState<{ project: ProjectListItem; details: string[] } | null>(null);

  const finOf = (id: number) => financials?.projects.find((f) => f.project.id === id);

  const filtered = projects.filter(
    (p) => (!statusFilter || p.status === statusFilter) && (!disciplineFilter || p.discipline === disciplineFilter),
  );

  const columns: Column<ProjectListItem>[] = [
    { key: "code", header: t("projects.code"), value: (p) => p.code, render: (p) => <span className="tnum text-xs text-slate-500">{p.code}</span>, width: "110px" },
    { key: "name", header: t("common.name"), value: (p) => p.name, render: (p) => <span className="font-medium">{p.name}</span> },
    { key: "client", header: t("projects.client"), value: (p) => p.clientName },
    { key: "discipline", header: t("projects.discipline"), value: (p) => t(`discipline.${p.discipline}`) },
    {
      key: "value",
      header: t("cash.contractValueExcludingVat"),
      value: (p) => finOf(p.id)?.contractValueEgp ?? 0,
      render: (p) => <span className="tnum">{base.format(finOf(p.id)?.contractValueEgp ?? 0)}</span>,
      align: "end",
    },
    {
      key: "certified",
      header: t("cash.certifiedRevenue"),
      value: (p) => finOf(p.id)?.certifiedRatioBp ?? 0,
      render: (p) => {
        const fin = finOf(p.id);
        return (
          <div className="min-w-28">
            <div className="mb-1 flex justify-between text-xs text-slate-500">
              <span className="tnum">{fmt.percent(fin?.certifiedRatioBp ?? 0)}</span>
            </div>
            <RatioBar ratioBp={fin?.collectionRatioBp ?? 0} secondaryBp={fin?.certifiedRatioBp ?? 0} />
          </div>
        );
      },
    },
    {
      key: "status",
      header: t("common.status"),
      value: (p) => p.status,
      render: (p) => <Badge value={p.status} label={t(`status.${p.status}`)} />,
      width: "110px",
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      width: "120px",
      render: (p) => p.archivedAt ? <Badge value="CANCELLED" label={t("lifecycle.archived")} /> : (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" onClick={() => setEditing(p)}>{t("common.edit")}</Button>
          <Button
            variant="ghost"
            className="!text-red-600"
            onClick={async () => {
              const info = await projectCascadeInfo(p.id);
              setDeleting({
                project: p,
                details: [
                  `${info.contracts} ${t("contracts.title")}`,
                  `${info.certificates} ${t("certificates.title")}`,
                  `${info.payments} ${t("payments.title")}`,
                  `${info.expenses} ${t("expenses.title")}`,
                ],
              });
            }}
          >
            {t("common.delete")}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("projects.title")}</h1>
        <Button
          variant="primary"
          onClick={async () => setCreating(await nextProjectCode(settings?.projectCodePrefix ?? "PRJ"))}
        >
          <Plus size={16} />
          {t("projects.newProject")}
        </Button>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(p) => p.id}
        onRowClick={(p) => { if (!p.archivedAt) navigate(`/projects/${p.id}`); }}
        emptyMessage={isLoading ? t("common.loading") : t("common.empty")}
        toolbar={
          <>
            <Select className="!w-40" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ProjectStatus | "")}>
              <option value="">{t("common.status")}: {t("common.all")}</option>
              {(["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"] as const).map((s) => (
                <option key={s} value={s}>{t(`status.${s}`)}</option>
              ))}
            </Select>
            <Select className="!w-40" value={disciplineFilter} onChange={(e) => setDisciplineFilter(e.target.value)}>
              <option value="">{t("projects.discipline")}: {t("common.all")}</option>
              {(["HVAC", "PLUMBING", "FIREFIGHTING", "ELECTRICAL", "BIM", "ARCHITECTURE", "STRUCTURAL", "ID", "MULTI"] as const).map((d) => (
                <option key={d} value={d}>{t(`discipline.${d}`)}</option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
              {t("lifecycle.includeArchived")}
            </label>
          </>
        }
      />

      {creating !== null && (
        <ProjectForm
          nextCode={creating}
          busy={mutations.create.isPending}
          onClose={() => setCreating(null)}
          onSubmit={(input) => mutations.create.mutate({ code: creating, input }, { onSuccess: () => setCreating(null) })}
        />
      )}
      {editing && (
        <ProjectForm
          initial={editing}
          busy={mutations.update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input, revision) => mutations.update.mutate({ id: editing.id, input, revision }, { onSuccess: () => setEditing(null) })}
        />
      )}
      {deleting && (
        <ConfirmDialog
          message={`${t("common.confirmDeleteMessage")} ${deleting.project.name}`}
          details={deleting.details}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => mutations.remove.mutate(deleting.project.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </div>
  );
}
