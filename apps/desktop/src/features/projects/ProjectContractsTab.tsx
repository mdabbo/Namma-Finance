import { useTranslation } from "react-i18next";
import { Plus, ReceiptText } from "lucide-react";
import type { Contract } from "@mep/core";
import { useContractRevisions } from "../../repositories/contracts";
import { type WorkspaceFinancials } from "../../repositories/financials";
import { DataTable, type Column } from "../../components/DataTable";
import { Button, Card, EmptyState, SectionHeader } from "../../components/ui";
import { useFormat } from "../../lib/format";

export function ProjectContracts({
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
            onClick={() => onDelete(contract)}
          >
            {t("lifecycle.archiveContract")}
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

export function ContractRevisionHistory({ contractId }: { contractId: number }) {
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

