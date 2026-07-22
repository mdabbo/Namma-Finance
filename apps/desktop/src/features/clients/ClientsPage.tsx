import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { Client } from "@mep/core";
import { computeClientFinancials } from "@mep/core";
import { useClientMutations, useClients, clientCascadeInfo, type ClientListItem } from "../../repositories/clients";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Badge, Button } from "../../components/ui";
import { useBaseMoney } from "../../lib/baseCurrency";
import { ClientForm } from "./ClientForm";

export function ClientsPage() {
  const { t } = useTranslation();
  const base = useBaseMoney();
  const navigate = useNavigate();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: clients = [], isLoading } = useClients(includeArchived);
  const { data: financials } = useWorkspaceFinancials();
  const mutations = useClientMutations();

  const [editing, setEditing] = useState<Client | null | "new">(null);
  const [deleting, setDeleting] = useState<{ client: ClientListItem; details: string[] } | null>(null);

  const rollup = (clientId: number) =>
    financials ? computeClientFinancials(clientId, financials.projects) : null;

  const columns: Column<ClientListItem>[] = [
    { key: "name", header: t("common.name"), value: (c) => c.name, render: (c) => <span className="font-medium">{c.name}</span> },
    { key: "company", header: t("clients.company"), value: (c) => c.company },
    { key: "phone", header: t("common.phone"), value: (c) => c.phone, render: (c) => <span className="tnum">{c.phone}</span> },
    { key: "projects", header: t("clients.projects"), value: (c) => c.projectCount, align: "end" },
    {
      key: "contracts",
      header: t("cash.contractValueExcludingVat"),
      value: (c) => rollup(c.id)?.contractValueEgp ?? 0,
      render: (c) => <span className="tnum">{base.format(rollup(c.id)?.contractValueEgp ?? 0)}</span>,
      align: "end",
    },
    {
      key: "certificateCollections",
      header: t("cash.certificateCollections"),
      value: (c) => rollup(c.id)?.certificateCollectionsEgp ?? 0,
      render: (c) => <span className="tnum text-emerald-600 dark:text-emerald-400">{base.format(rollup(c.id)?.certificateCollectionsEgp ?? 0)}</span>,
      align: "end",
    },
    {
      key: "totalCashIn",
      header: t("cash.totalActualCashIn"),
      value: (c) => rollup(c.id)?.totalActualCashInEgp ?? 0,
      render: (c) => <span className="tnum text-emerald-600 dark:text-emerald-400">{base.format(rollup(c.id)?.totalActualCashInEgp ?? 0)}</span>,
      align: "end",
    },
    {
      key: "outstanding",
      header: t("cash.outstandingReceivables"),
      value: (c) => rollup(c.id)?.outstandingEgp ?? 0,
      render: (c) => {
        const v = rollup(c.id)?.outstandingEgp ?? 0;
        return <span className={`tnum ${v > 0 ? "text-amber-600 dark:text-amber-400" : ""}`}>{base.format(v)}</span>;
      },
      align: "end",
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      width: "120px",
      render: (c) => c.archivedAt ? <Badge value="CANCELLED" label={t("lifecycle.archived")} /> : (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" onClick={() => setEditing(c)}>
            {t("common.edit")}
          </Button>
          <Button
            variant="ghost"
            className="!text-red-600"
            onClick={async () => {
              const info = await clientCascadeInfo(c.id);
              const details = [
                `${info.projects} ${t("clients.projects")}`,
                `${info.contracts} ${t("contracts.title")}`,
                `${info.certificates} ${t("certificates.title")}`,
                `${info.payments} ${t("payments.title")}`,
              ];
              setDeleting({ client: c, details });
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
        <h1 className="text-xl font-semibold">{t("clients.title")}</h1>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} />
          {t("clients.newClient")}
        </Button>
      </div>

      <label className="mb-3 flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
        {t("lifecycle.includeArchived")}
      </label>

      <DataTable
        rows={clients}
        columns={columns}
        rowKey={(c) => c.id}
        onRowClick={(c) => { if (!c.archivedAt) navigate(`/clients/${c.id}`); }}
        emptyMessage={isLoading ? t("common.loading") : t("common.empty")}
        initialSort={{ key: "name", dir: "asc" }}
      />

      {editing !== null && (
        <ClientForm
          initial={editing === "new" ? null : editing}
          busy={mutations.create.isPending || mutations.update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            if (editing === "new") mutations.create.mutate(input, { onSuccess: () => setEditing(null) });
            else mutations.update.mutate({ id: editing.id, input }, { onSuccess: () => setEditing(null) });
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          message={`${t("common.confirmDeleteMessage")} ${deleting.client.name}`}
          details={deleting.details}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => mutations.remove.mutate(deleting.client.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </div>
  );
}
