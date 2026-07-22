import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, Plus } from "lucide-react";
import { expenseSchema, type ExpenseInput } from "@mep/core";
import { useCategories, useExpenseMutations, useExpenses, type ExpenseListItem } from "../../repositories/expenses";
import { useProjects } from "../../repositories/projects";
import { useCurrencyRates } from "../../repositories/currencies";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Button, Field, Input, Modal, Select } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { todayIso, useFormat } from "../../lib/format";
import { open } from "@tauri-apps/plugin-dialog";

export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const { data: expenses = [], isLoading } = useExpenses();
  const { data: categories = [] } = useCategories();
  const mutations = useExpenseMutations();

  const [categoryFilter, setCategoryFilter] = useState(0);
  const [projectFilter, setProjectFilter] = useState<"" | "overhead" | number>("");
  const [editing, setEditing] = useState<ExpenseListItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<ExpenseListItem | null>(null);
  const { data: projects = [] } = useProjects();

  const catName = (e: ExpenseListItem) => (i18n.language === "ar" ? e.categoryAr : e.categoryEn);

  const filtered = expenses.filter(
    (e) =>
      (!categoryFilter || e.categoryId === categoryFilter) &&
      (projectFilter === "" || (projectFilter === "overhead" ? e.projectId === null : e.projectId === projectFilter)),
  );

  const columns: Column<ExpenseListItem>[] = [
    { key: "number", header: t("expenses.number"), value: (e) => e.number, render: (e) => <span className="tnum">{e.number}</span>, width: "150px" },
    { key: "date", header: t("common.date"), value: (e) => e.date, render: (e) => <span className="tnum">{fmt.date(e.date)}</span>, width: "110px" },
    { key: "category", header: t("expenses.category"), value: catName },
    { key: "description", header: t("common.description"), value: (e) => e.description, render: (e) => (
      <div className="flex items-center gap-1.5">
        {e.description}
        {e.attachmentPath && <Paperclip size={13} className="text-slate-400" />}
        {e.personPaymentId !== null && (
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800" title={t("expenses.autoTeamPayment")}>
            {t("expenses.autoTeamPayment")}
          </span>
        )}
      </div>
    ) },
    {
      key: "project",
      header: t("expenses.project"),
      value: (e) => e.projectName ?? t("common.overhead"),
      render: (e) =>
        e.projectName ? (
          <span>{e.projectName}</span>
        ) : (
          <span className="text-slate-400">{t("common.overhead")}</span>
        ),
    },
    { key: "supplier", header: t("expenses.supplier"), value: (e) => e.supplier },
    {
      key: "amount",
      header: t("common.amount"),
      value: (e) => e.amountMinor,
      render: (e) => <span className="font-medium tnum">{fmt.money(e.amountMinor, e.currency)}</span>,
      align: "end",
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      width: "120px",
      render: (e) =>
        e.personPaymentId !== null ? null : (
          <div className="flex justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
            <Button variant="ghost" onClick={() => setEditing(e)}>{t("common.edit")}</Button>
            <Button variant="ghost" className="!text-red-600" onClick={() => setDeleting(e)}>{t("common.delete")}</Button>
          </div>
        ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("expenses.title")}</h1>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} /> {t("expenses.newExpense")}
        </Button>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(e) => e.id}
        emptyMessage={isLoading ? t("common.loading") : t("common.empty")}
        toolbar={
          <>
            <Select className="!w-44" value={categoryFilter} onChange={(e) => setCategoryFilter(Number(e.target.value))}>
              <option value={0}>{t("expenses.category")}: {t("common.all")}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{i18n.language === "ar" ? c.nameAr : c.nameEn}</option>
              ))}
            </Select>
            <Select
              className="!w-52"
              value={String(projectFilter)}
              onChange={(e) => {
                const v = e.target.value;
                setProjectFilter(v === "" ? "" : v === "overhead" ? "overhead" : Number(v));
              }}
            >
              <option value="">{t("expenses.project")}: {t("common.all")}</option>
              <option value="overhead">{t("common.overhead")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
              ))}
            </Select>
          </>
        }
      />

      {editing !== null && (
        <ExpenseForm
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
          message={`${t("common.confirmDeleteMessage")} ${deleting.description}`}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => mutations.remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </div>
  );
}

function ExpenseForm({
  initial,
  onSubmit,
  onClose,
  busy,
}: {
  initial: ExpenseListItem | null;
  onSubmit: (input: ExpenseInput) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { data: categories = [] } = useCategories();
  const { data: projects = [] } = useProjects();
  const { data: rates = [] } = useCurrencyRates();

  const [form, setForm] = useState({
    date: initial?.date ?? todayIso(),
    categoryId: initial?.categoryId ?? 0,
    description: initial?.description ?? "",
    projectId: initial?.projectId ?? null,
    supplier: initial?.supplier ?? "",
    amountMinor: initial?.amountMinor ?? 0,
    currency: initial?.currency ?? "EGP",
    fxRateMicro: initial?.fxRateMicro ?? 1_000_000,
    attachmentPath: initial?.attachmentPath ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit() {
    const parsed = expenseSchema.safeParse({
      ...form,
      projectId: form.projectId,
      supplier: form.supplier || null,
      attachmentPath: form.attachmentPath || null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0])] = t(`validation.${issue.message}`, issue.message);
      setErrors(errs);
      return;
    }
    onSubmit(parsed.data);
  }

  return (
    <Modal title={initial ? t("common.edit") : t("expenses.newExpense")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.date")}>
          <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        </Field>
        <Field label={t("expenses.category")} error={errors.categoryId}>
          <Select value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: Number(e.target.value) }))}>
            <option value={0}>—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{i18n.language === "ar" ? c.nameAr : c.nameEn}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("common.description")} error={errors.description} className="col-span-2">
          <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
        <Field label={t("expenses.project")}>
          <Select
            value={form.projectId ?? ""}
            onChange={(e) => {
              const projectId = e.target.value === "" ? null : Number(e.target.value);
              const project = projects.find((p) => p.id === projectId);
              setForm((f) => ({
                ...f,
                projectId,
                currency: project?.currency ?? "EGP",
                fxRateMicro: project?.fxRateMicro ?? rates.find((r) => r.code === (project?.currency ?? "EGP"))?.fxRateMicro ?? 1_000_000,
              }));
            }}
          >
            <option value="">{t("common.overhead")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("expenses.supplier")}>
          <Input value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} />
        </Field>
        <Field label={t("common.amount")} error={errors.amountMinor}>
          <MoneyInput currency={form.currency} valueMinor={form.amountMinor} onChange={(v) => setForm((f) => ({ ...f, amountMinor: v ?? 0 }))} />
        </Field>
        <Field label={t("expenses.attachment")}>
          <div className="flex gap-2">
            <Input value={form.attachmentPath} readOnly className="flex-1 text-xs" dir="ltr" />
            <Button
              onClick={async () => {
                const path = await open({ multiple: false });
                if (typeof path === "string") setForm((f) => ({ ...f, attachmentPath: path }));
              }}
            >
              …
            </Button>
          </div>
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}
