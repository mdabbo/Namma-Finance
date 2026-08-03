import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, FileCheck2, FileDown, Hourglass, Plus } from "lucide-react";
import { currencyInfo, type CertificateStatus } from "@mep/core";
import { useCertificateMutations, useCertificates, type CertificateListItem } from "../../repositories/certificates";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { KpiCard } from "../../components/KpiCard";
import { PrintPortal } from "../../components/PrintPortal";
import { Badge, Button, PageHeader, Select } from "../../components/ui";
import { minorToInput, todayIso, useFormat } from "../../lib/format";
import type { SavedViewFilters } from "../../lib/savedViews";
import { useBaseMoney } from "../../lib/baseCurrency";
import { certificateSectionKpis, inProjectScope, parseFinanceScope } from "../finance/financeSectionModel";
import { FinanceScopeChips, type FinanceScopeChip } from "../finance/FinanceScopeChips";
import { usePaymentMutations } from "../../repositories/payments";
import { PaymentForm, type PaymentDefaults } from "../payments/PaymentForm";
import { CertificateForm } from "./CertificateForm";
import { CertificateDocument } from "./CertificateDocument";

const CERTIFICATE_STATUSES: readonly CertificateStatus[] = ["DRAFT", "SUBMITTED", "APPROVED", "PAID"];

export function CertificatesPage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const [searchParams, setSearchParams] = useSearchParams();
  const base = useBaseMoney();
  const scope = parseFinanceScope(searchParams, "certificates");
  const attentionView = scope.view;
  const { data: certificates = [], isLoading } = useCertificates();
  const { data: financials } = useWorkspaceFinancials();
  const mutations = useCertificateMutations();

  function clearScopeParam(name: string) {
    const next = new URLSearchParams(searchParams);
    next.delete(name);
    setSearchParams(next);
  }

  const scopedProject = scope.projectId !== null
    ? financials?.projects.find((p) => p.project.id === scope.projectId)?.project ?? null
    : null;
  const kpis = certificateSectionKpis(financials?.projects ?? [], scope.projectId);

  const [statusFilter, setStatusFilter] = useState<CertificateStatus | "">("");
  const [editing, setEditing] = useState<CertificateListItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<CertificateListItem | null>(null);
  const [printing, setPrinting] = useState<CertificateListItem | null>(null);
  const [paying, setPaying] = useState<PaymentDefaults | null>(null);
  const paymentMutations = usePaymentMutations();

  const stateOf = (cert: CertificateListItem) =>
    financials?.contractStates.get(cert.contractId)?.certificates.find((cs) => cs.certificate.id === cert.id);

  function submitDraft(c: CertificateListItem) {
    const submissionDate = todayIso();
    const dueBeforeSubmission = !!c.dueDateOverride && c.dueDateOverride < submissionDate;
    if (dueBeforeSubmission && !window.confirm(t("validation.confirm_due_before_submission"))) return;
    mutations.setStatus.mutate({ id: c.id, status: "SUBMITTED", submissionDate, dueDateConfirmed: dueBeforeSubmission });
  }

  const filtered = useMemo(
    () =>
      certificates.filter(
        (certificate) =>
          (!statusFilter || certificate.status === statusFilter) &&
          inProjectScope(certificate.projectId, scope.projectId) &&
          (attentionView !== "overdue" || stateOf(certificate)?.overdue),
      ),
    [certificates, financials, statusFilter, attentionView, scope.projectId],
  );

  const scopeChips: FinanceScopeChip[] = [
    ...(scopedProject
      ? [{
          key: "project",
          label: `${scopedProject.code} · ${scopedProject.name}`,
          onClear: () => clearScopeParam("projectId"),
        }]
      : []),
    ...(attentionView === "overdue"
      ? [{
          key: "view",
          label: t("dashboard.filtered.overdue"),
          onClear: () => clearScopeParam("view"),
        }]
      : []),
  ];

  const columns: Column<CertificateListItem>[] = [
    { key: "number", header: t("certificates.number"), value: (c) => c.number, render: (c) => <span className="font-medium tnum">{c.number}</span> },
    { key: "project", header: t("projects.single"), value: (c) => `${c.projectCode} ${c.projectName}`, render: (c) => (
      <div>
        <p>{c.projectName}</p>
        <p className="text-xs text-slate-400 tnum">{c.projectCode} · {c.contractNumber}</p>
      </div>
    ) },
    { key: "date", header: t("common.date"), value: (c) => c.date, render: (c) => <span className="tnum">{fmt.date(c.date)}</span> },
    // Amounts are in the certificate's own currency, so it travels with them.
    { key: "currency", header: t("common.currency"), value: (c) => c.currency, width: "90px" },
    {
      key: "gross",
      header: t("certificates.gross"),
      value: (c) => c.grossMinor,
      exportValue: (c) => minorToInput(c.grossMinor, currencyInfo(c.currency).exponent),
      render: (c) => <span className="tnum">{fmt.money(c.grossMinor, c.currency)}</span>,
      align: "end",
    },
    {
      key: "net",
      header: t("certificates.netPayable"),
      value: (c) => stateOf(c)?.breakdown.netPayableMinor ?? 0,
      exportValue: (c) =>
        minorToInput(stateOf(c)?.breakdown.netPayableMinor ?? 0, currencyInfo(c.currency).exponent),
      render: (c) => <span className="font-medium tnum">{fmt.money(stateOf(c)?.breakdown.netPayableMinor ?? 0, c.currency)}</span>,
      align: "end",
    },
    {
      key: "unpaid",
      header: t("certificates.unpaid"),
      value: (c) => stateOf(c)?.unpaidMinor ?? 0,
      exportValue: (c) => minorToInput(stateOf(c)?.unpaidMinor ?? 0, currencyInfo(c.currency).exponent),
      render: (c) => {
        const unpaid = stateOf(c)?.unpaidMinor ?? 0;
        return <span className={`tnum ${unpaid > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>{fmt.money(unpaid, c.currency)}</span>;
      },
      align: "end",
    },
    {
      key: "status",
      header: t("common.status"),
      value: (c) => c.status,
      render: (c) => (
        <div className="flex items-center gap-1.5">
          <Badge value={c.status} label={t(`status.${c.status}`)} />
          {stateOf(c)?.overdue && <Badge value="OVERDUE" label={t("certificates.overdue")} />}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      width: "230px",
      render: (c) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {c.status === "DRAFT" && (
            <Button variant="ghost" onClick={() => submitDraft(c)}>
              {t("certificates.markSubmitted")}
            </Button>
          )}
          {c.status === "SUBMITTED" && (
            <Button variant="ghost" onClick={() => mutations.setStatus.mutate({ id: c.id, status: "APPROVED" })}>
              {t("certificates.markApproved")}
            </Button>
          )}
          {c.status === "APPROVED" && (
            <Button
              variant="ghost"
              onClick={() =>
                setPaying({
                  projectId: c.projectId,
                  contractId: c.contractId,
                  certificateId: c.id,
                  amountMinor: stateOf(c)?.unpaidMinor ?? 0,
                })
              }
            >
              {t("certificates.markPaid")}
            </Button>
          )}
          <Button variant="ghost" title={t("common.exportPdf")} onClick={() => setPrinting(c)}>
            <FileDown size={15} />
          </Button>
          <Button variant="ghost" onClick={() => setEditing(c)}>{t("common.edit")}</Button>
          <Button variant="ghost" className="!text-red-600" onClick={() => setDeleting(c)}>
            {t("lifecycle.voidCertificate")}
          </Button>
        </div>
      ),
    },
  ];

  const printingState = printing ? stateOf(printing) : null;
  const printingContract = printing ? financials?.contractStates.get(printing.contractId)?.contract : null;

  return (
    <div>
      <PageHeader
        title={t("certificates.title")}
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus size={16} aria-hidden="true" /> {t("certificates.newCertificate")}
          </Button>
        }
      />

      {financials && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3" aria-label={t("financeSection.kpis")}>
          <KpiCard
            label={t("financeSection.invoiced")}
            value={base.format(kpis.invoicedEgp)}
            icon={FileCheck2}
            hint={t("dashboard.reportingCurrency", { currency: base.code })}
          />
          <KpiCard
            label={t("financeSection.outstanding")}
            value={base.format(kpis.outstandingEgp)}
            icon={Hourglass}
            tone={kpis.outstandingEgp > 0 ? "warning" : "default"}
          />
          <KpiCard
            label={t("financeSection.overdueCount")}
            value={String(kpis.overdueCount)}
            icon={AlertTriangle}
            tone={kpis.overdueCount > 0 ? "negative" : "positive"}
          />
        </div>
      )}

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(c) => c.id}
        loading={isLoading || (attentionView === "overdue" && !financials)}
        emptyMessage={t("common.empty")}
        exportName="certificates"
        viewKey="certificates"
        filters={{
          status: statusFilter,
          project: scope.projectId === null ? "" : String(scope.projectId),
          view: attentionView ?? "",
        }}
        onApplyFilters={(next: SavedViewFilters) => {
          const status = next.status ?? "";
          setStatusFilter(CERTIFICATE_STATUSES.includes(status as CertificateStatus)
            ? (status as CertificateStatus) : "");
          const params = new URLSearchParams(searchParams);
          const project = Number(next.project);
          if (Number.isSafeInteger(project) && project > 0) params.set("project", String(project));
          else params.delete("project");
          if (next.view === "overdue") params.set("view", next.view);
          else params.delete("view");
          setSearchParams(params, { replace: true });
        }}
        onResetFilters={() => {
          setStatusFilter("");
          const params = new URLSearchParams(searchParams);
          params.delete("project");
          params.delete("view");
          setSearchParams(params, { replace: true });
        }}
        toolbar={
          <>
            <Select className="!w-44" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as CertificateStatus | "")}>
              <option value="">{t("common.status")}: {t("common.all")}</option>
              {(["DRAFT", "SUBMITTED", "APPROVED", "PAID"] as const).map((s) => (
                <option key={s} value={s}>{t(`status.${s}`)}</option>
              ))}
            </Select>
            <FinanceScopeChips chips={scopeChips} clearLabel={t("common.clearFilters")} />
          </>
        }
      />

      {editing !== null && (
        <CertificateForm
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
          title={t("lifecycle.voidCertificate")}
          confirmLabel={t("lifecycle.void")}
          requireReason
          message={`${t("lifecycle.confirmVoidCertificate")} (${deleting.number})`}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={(reason) => mutations.remove.mutate({ id: deleting.id, reason }, { onSuccess: () => setDeleting(null) })}
        />
      )}

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

      {printing && printingState && printingContract && (
        <PrintPortal onDone={() => setPrinting(null)}>
          <CertificateDocument cert={printing} contract={printingContract} breakdown={printingState.breakdown} />
        </PrintPortal>
      )}
    </div>
  );
}
