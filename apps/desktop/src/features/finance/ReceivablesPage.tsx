import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlarmClock, CalendarClock, CircleDollarSign } from "lucide-react";
import {
  currencyInfo,
  selectOpenReceivables,
  selectUpcomingCollections,
  type ReceivableCertificate,
} from "@mep/core";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { usePaymentMutations } from "../../repositories/payments";
import { DataTable, type Column } from "../../components/DataTable";
import { KpiCard } from "../../components/KpiCard";
import { Badge, Button, PageHeader } from "../../components/ui";
import { minorToInput, todayIso, useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import { PaymentForm, type PaymentDefaults } from "../payments/PaymentForm";
import { financeContractInputs, inProjectScope, parseFinanceScope } from "./financeSectionModel";
import { FinanceScopeChips, type FinanceScopeChip } from "./FinanceScopeChips";

export function ReceivablesPage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = parseFinanceScope(searchParams, "receivables");
  const workspace = useWorkspaceFinancials();
  const financials = workspace.data;
  const paymentMutations = usePaymentMutations();
  const [paying, setPaying] = useState<PaymentDefaults | null>(null);

  const receivables = useMemo(
    () => (financials ? selectOpenReceivables(financeContractInputs(financials)) : []),
    [financials],
  );
  const scoped = receivables.filter((item) =>
    inProjectScope(item.projectId, scope.projectId) &&
    (scope.view !== "overdue" || item.overdue));
  const upcoming = useMemo(
    () =>
      selectUpcomingCollections(
        receivables.filter((item) => inProjectScope(item.projectId, scope.projectId)),
        todayIso(),
        60,
      ),
    [receivables, scope.projectId],
  );

  const projectById = new Map(
    (financials?.projects ?? []).map((item) => [item.project.id, item.project]),
  );
  const scopedProject = scope.projectId !== null ? projectById.get(scope.projectId) ?? null : null;
  const totalEgp = scoped.reduce((total, item) => total + item.unpaidEgp, 0);
  const overdueEgp = scoped
    .filter((item) => item.overdue)
    .reduce((total, item) => total + item.unpaidEgp, 0);

  function clearScopeParam(name: string) {
    const next = new URLSearchParams(searchParams);
    next.delete(name);
    setSearchParams(next);
  }

  const scopeChips: FinanceScopeChip[] = [
    ...(scopedProject
      ? [{
          key: "project",
          label: `${scopedProject.code} · ${scopedProject.name}`,
          onClear: () => clearScopeParam("projectId"),
        }]
      : []),
    ...(scope.view === "overdue"
      ? [{
          key: "view",
          label: t("dashboard.filtered.overdue"),
          onClear: () => clearScopeParam("view"),
        }]
      : []),
  ];

  const columns: Column<ReceivableCertificate>[] = [
    {
      key: "number",
      header: t("certificates.number"),
      value: (row) => row.certificateNumber,
      render: (row) => <span className="font-medium tnum">{row.certificateNumber}</span>,
    },
    {
      key: "project",
      header: t("projects.single"),
      value: (row) => {
        const project = projectById.get(row.projectId);
        return project ? `${project.code} ${project.name}` : row.contractNumber;
      },
      render: (row) => {
        const project = projectById.get(row.projectId);
        return (
          <div>
            <p>{project?.name ?? row.contractNumber}</p>
            <p className="text-xs text-slate-400 tnum">
              {project?.code} · {row.contractNumber}
            </p>
          </div>
        );
      },
    },
    {
      key: "dueDate",
      header: t("certificates.dueDate"),
      value: (row) => row.dueDate,
      render: (row) => <span className="tnum">{fmt.date(row.dueDate)}</span>,
    },
    {
      key: "status",
      header: t("common.status"),
      value: (row) => (row.overdue ? "OVERDUE" : row.status),
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <Badge value={row.status} label={t(`status.${row.status}`)} />
          {row.overdue && <Badge value="OVERDUE" label={t("certificates.overdue")} />}
        </div>
      ),
    },
    {
      key: "currency",
      header: t("common.currency"),
      value: (row) => row.currency,
      width: "90px",
    },
    {
      key: "unpaid",
      header: t("certificates.unpaid"),
      value: (row) => row.unpaidMinor,
      // Sorting uses exact minor units; the export must carry major units so a
      // spreadsheet does not sum piasters as if they were pounds.
      exportValue: (row) => minorToInput(row.unpaidMinor, currencyInfo(row.currency).exponent),
      render: (row) => (
        <span className={`font-medium tnum ${row.overdue ? "text-red-600 dark:text-red-400" : ""}`}>
          {fmt.money(row.unpaidMinor, row.currency)}
        </span>
      ),
      align: "end",
    },
    {
      key: "unpaidBase",
      header: `${t("financeSection.consolidated")} (${base.code})`,
      value: (row) => row.unpaidEgp,
      exportValue: (row) =>
        minorToInput(base.convert(row.unpaidEgp), currencyInfo(base.code).exponent),
      render: (row) => <span className="tnum">{base.format(row.unpaidEgp)}</span>,
      align: "end",
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      width: "150px",
      render: (row) => (
        <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
          <Button
            variant="ghost"
            onClick={() =>
              setPaying({
                projectId: row.projectId,
                contractId: row.contractId,
                certificateId: row.certificateId,
                amountMinor: row.unpaidMinor,
              })
            }
          >
            {t("certificates.markPaid")}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("financeSection.receivables")}
        description={t("financeSection.receivablesDescription")}
      />

      {financials && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3" aria-label={t("financeSection.kpis")}>
          <KpiCard
            label={t("financeSection.currentReceivables")}
            value={base.format(totalEgp)}
            icon={CircleDollarSign}
            hint={t("dashboard.reportingCurrency", { currency: base.code })}
            tone={totalEgp > 0 ? "warning" : "default"}
          />
          <KpiCard
            label={t("financeSection.overdueReceivables")}
            value={base.format(overdueEgp)}
            icon={AlarmClock}
            tone={overdueEgp > 0 ? "negative" : "positive"}
          />
          <KpiCard
            label={t("financeSection.upcomingCollections")}
            value={base.format(upcoming.totalEgp)}
            icon={CalendarClock}
            hint={t("financeSection.dueBy", { date: fmt.date(upcoming.horizonEndIso) })}
          />
        </div>
      )}

      <DataTable
        rows={scoped}
        columns={columns}
        rowKey={(row) => row.certificateId}
        loading={workspace.isLoading}
        emptyMessage={t("financeSection.emptyReceivables")}
        density="compact"
        initialSort={{ key: "dueDate", dir: "asc" }}
        exportName="receivables"
        viewKey="finance-receivables"
        toolbar={<FinanceScopeChips chips={scopeChips} clearLabel={t("common.clearFilters")} />}
      />

      {paying && (
        <PaymentForm
          defaults={paying}
          busy={paymentMutations.create.isPending}
          onClose={() => setPaying(null)}
          onSubmit={(input, allocations) =>
            paymentMutations.create.mutate({ input, allocations }, { onSuccess: () => setPaying(null) })
          }
        />
      )}
    </div>
  );
}
