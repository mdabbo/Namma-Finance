import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CalendarDays, Coins, Plus, Wallet } from "lucide-react";
import { usePaymentMutations, usePayments, type PaymentListItem } from "../../repositories/payments";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { KpiCard } from "../../components/KpiCard";
import { Badge, Button, PageHeader, Select } from "../../components/ui";
import { todayIso, useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import { inProjectScope, parseFinanceScope, paymentSectionKpis } from "../finance/financeSectionModel";
import { FinanceScopeChips, type FinanceScopeChip } from "../finance/FinanceScopeChips";
import { PaymentForm } from "./PaymentForm";

export function PaymentsPage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = parseFinanceScope(searchParams, "payments");
  const attentionView = scope.view;
  const [includeVoided, setIncludeVoided] = useState(false);
  const { data: payments = [], isLoading } = usePayments(includeVoided);
  const { data: financials } = useWorkspaceFinancials();
  const mutations = usePaymentMutations();

  const [kindFilter, setKindFilter] = useState("");
  const [editing, setEditing] = useState<PaymentListItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<PaymentListItem | null>(null);

  function clearScopeParam(name: string) {
    const next = new URLSearchParams(searchParams);
    next.delete(name);
    setSearchParams(next);
  }

  const scopedProject = scope.projectId !== null
    ? financials?.projects.find((p) => p.project.id === scope.projectId)?.project ?? null
    : null;
  const kpis = paymentSectionKpis({
    projects: financials?.projects ?? [],
    cashIn: financials?.cashIn ?? [],
    projectId: scope.projectId,
    todayIso: todayIso(),
  });

  const filtered = payments.filter(
    (payment) =>
      (!kindFilter || payment.kind === kindFilter) &&
      inProjectScope(payment.projectId, scope.projectId) &&
      (attentionView !== "unallocated" || payment.unallocatedMinor > 0),
  );

  const scopeChips: FinanceScopeChip[] = [
    ...(scopedProject
      ? [{
          key: "project",
          label: `${scopedProject.code} · ${scopedProject.name}`,
          onClear: () => clearScopeParam("projectId"),
        }]
      : []),
    ...(attentionView === "unallocated"
      ? [{
          key: "view",
          label: t("dashboard.filtered.unallocated"),
          onClear: () => clearScopeParam("view"),
        }]
      : []),
  ];

  const columns: Column<PaymentListItem>[] = [
    { key: "number", header: t("payments.number"), value: (p) => p.number, render: (p) => <span className="font-medium tnum">{p.number}</span> },
    {
      key: "project",
      header: t("projects.single"),
      value: (p) => `${p.projectCode} ${p.projectName}`,
      render: (p) => (
        <div>
          <p>{p.projectName}</p>
          <p className="text-xs text-slate-400 tnum">{p.projectCode} · {p.contractNumber}</p>
        </div>
      ),
    },
    { key: "kind", header: t("payments.kind"), value: (p) => p.kind, render: (p) => <Badge value={p.kind === "ADVANCE" ? "SUBMITTED" : p.kind === "RETENTION_RELEASE" ? "APPROVED" : "PAID"} label={t(`paymentKind.${p.kind}`)} /> },
    { key: "date", header: t("common.date"), value: (p) => p.date, render: (p) => <span className="tnum">{fmt.date(p.date)}</span> },
    { key: "method", header: t("payments.method"), value: (p) => t(`method.${p.method}`) },
    {
      key: "amount",
      header: t("common.amount"),
      value: (p) => p.amountMinor,
      render: (p) => <span className="font-medium tnum text-emerald-600 dark:text-emerald-400">{fmt.money(p.amountMinor, p.currency)}</span>,
      align: "end",
    },
    {
      key: "unallocated",
      header: t("payments.customerCredit"),
      value: (p) => p.unallocatedMinor,
      render: (p) => <span className="tnum text-amber-600 dark:text-amber-400">{fmt.money(p.unallocatedMinor, p.currency)}</span>,
      align: "end",
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      width: "120px",
      render: (p) => p.deletedAt ? <Badge value="CANCELLED" label={t("lifecycle.voided")} /> : (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" onClick={() => setEditing(p)}>{t("common.edit")}</Button>
          <Button variant="ghost" className="!text-red-600" onClick={() => setDeleting(p)}>{t("lifecycle.voidPayment")}</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("payments.title")}
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus size={16} aria-hidden="true" /> {t("payments.newPayment")}
          </Button>
        }
      />

      {financials && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3" aria-label={t("financeSection.kpis")}>
          <KpiCard
            label={t("financeSection.cashIn")}
            value={base.format(kpis.totalCashInEgp)}
            icon={Wallet}
            tone="positive"
            hint={t("dashboard.reportingCurrency", { currency: base.code })}
          />
          <KpiCard
            label={t("financeSection.cashInMonth")}
            value={base.format(kpis.monthCashInEgp)}
            icon={CalendarDays}
          />
          <KpiCard
            label={t("financeSection.customerCredit")}
            value={base.format(kpis.unallocatedCreditEgp)}
            icon={Coins}
            tone={kpis.unallocatedCreditEgp > 0 ? "warning" : "default"}
          />
        </div>
      )}

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(p) => p.id}
        loading={isLoading}
        emptyMessage={t("common.empty")}
        toolbar={<>
          <Select className="!w-48" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
            <option value="">{t("payments.kind")}: {t("common.all")}</option>
            {(["CERTIFICATE", "ADVANCE", "RETENTION_RELEASE"] as const).map((k) => (
              <option key={k} value={k}>{t(`paymentKind.${k}`)}</option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={includeVoided} onChange={(e) => setIncludeVoided(e.target.checked)} />
            {t("lifecycle.includeVoided")}
          </label>
          <FinanceScopeChips chips={scopeChips} clearLabel={t("common.clearFilters")} />
        </>}
      />

      {editing !== null && (
        <PaymentForm
          initial={editing === "new" ? null : editing}
          busy={mutations.create.isPending || mutations.update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input, allocations) => {
            if (editing === "new") mutations.create.mutate({ input, allocations }, { onSuccess: () => setEditing(null) });
            else mutations.update.mutate({ id: editing.id, input, allocations }, { onSuccess: () => setEditing(null) });
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t("lifecycle.voidPayment")}
          confirmLabel={t("lifecycle.void")}
          requireReason
          message={`${t("lifecycle.confirmVoidPayment")} (${deleting.number})`}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={(reason) => mutations.remove.mutate({ id: deleting.id, reason }, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </div>
  );
}
