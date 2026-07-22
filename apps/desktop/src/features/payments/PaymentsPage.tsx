import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { usePaymentMutations, usePayments, type PaymentListItem } from "../../repositories/payments";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Badge, Button, Select } from "../../components/ui";
import { useFormat } from "../../lib/format";
import { PaymentForm } from "./PaymentForm";

export function PaymentsPage() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const [includeVoided, setIncludeVoided] = useState(false);
  const { data: payments = [], isLoading } = usePayments(includeVoided);
  const mutations = usePaymentMutations();

  const [kindFilter, setKindFilter] = useState("");
  const [editing, setEditing] = useState<PaymentListItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<PaymentListItem | null>(null);

  const filtered = payments.filter((p) => !kindFilter || p.kind === kindFilter);

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
      render: (p) => p.deletedAt ? <Badge value="CANCELLED" label={t("lifecycle.void")} /> : (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" onClick={() => setEditing(p)}>{t("common.edit")}</Button>
          <Button variant="ghost" className="!text-red-600" onClick={() => setDeleting(p)}>{t("common.delete")}</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("payments.title")}</h1>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} /> {t("payments.newPayment")}
        </Button>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(p) => p.id}
        emptyMessage={isLoading ? t("common.loading") : t("common.empty")}
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
          message={`${t("common.confirmDeleteMessage")} ${deleting.number}`}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => mutations.remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </div>
  );
}
