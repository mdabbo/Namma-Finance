import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, Plus } from "lucide-react";
import type { CertificateStatus } from "@mep/core";
import { useCertificateMutations, useCertificates, type CertificateListItem } from "../../repositories/certificates";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PrintPortal } from "../../components/PrintPortal";
import { Badge, Button, Select } from "../../components/ui";
import { todayIso, useFormat } from "../../lib/format";
import { usePaymentMutations } from "../../repositories/payments";
import { PaymentForm, type PaymentDefaults } from "../payments/PaymentForm";
import { CertificateForm } from "./CertificateForm";
import { CertificateDocument } from "./CertificateDocument";

export function CertificatesPage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: certificates = [], isLoading } = useCertificates();
  const { data: financials } = useWorkspaceFinancials();
  const mutations = useCertificateMutations();

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
    () => certificates.filter((c) => !statusFilter || c.status === statusFilter),
    [certificates, statusFilter],
  );

  const columns: Column<CertificateListItem>[] = [
    { key: "number", header: t("certificates.number"), value: (c) => c.number, render: (c) => <span className="font-medium tnum">{c.number}</span> },
    { key: "project", header: t("projects.single"), value: (c) => `${c.projectCode} ${c.projectName}`, render: (c) => (
      <div>
        <p>{c.projectName}</p>
        <p className="text-xs text-slate-400 tnum">{c.projectCode} · {c.contractNumber}</p>
      </div>
    ) },
    { key: "date", header: t("common.date"), value: (c) => c.date, render: (c) => <span className="tnum">{fmt.date(c.date)}</span> },
    {
      key: "gross",
      header: t("certificates.gross"),
      value: (c) => c.grossMinor,
      render: (c) => <span className="tnum">{fmt.money(c.grossMinor, c.currency)}</span>,
      align: "end",
    },
    {
      key: "net",
      header: t("certificates.netPayable"),
      value: (c) => stateOf(c)?.breakdown.netPayableMinor ?? 0,
      render: (c) => <span className="font-medium tnum">{fmt.money(stateOf(c)?.breakdown.netPayableMinor ?? 0, c.currency)}</span>,
      align: "end",
    },
    {
      key: "unpaid",
      header: t("certificates.unpaid"),
      value: (c) => stateOf(c)?.unpaidMinor ?? 0,
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
          <Button variant="ghost" className="!text-red-600" onClick={() => setDeleting(c)}>{t("common.delete")}</Button>
        </div>
      ),
    },
  ];

  const printingState = printing ? stateOf(printing) : null;
  const printingContract = printing ? financials?.contractStates.get(printing.contractId)?.contract : null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("certificates.title")}</h1>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} /> {t("certificates.newCertificate")}
        </Button>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(c) => c.id}
        emptyMessage={isLoading ? t("common.loading") : t("common.empty")}
        toolbar={
          <Select className="!w-44" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as CertificateStatus | "")}>
            <option value="">{t("common.status")}: {t("common.all")}</option>
            {(["DRAFT", "SUBMITTED", "APPROVED", "PAID"] as const).map((s) => (
              <option key={s} value={s}>{t(`status.${s}`)}</option>
            ))}
          </Select>
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
          message={`${t("common.confirmDeleteMessage")} ${deleting.number}`}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => mutations.remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
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
