import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Building2, CalendarDays, FolderKanban, Paperclip, Plus, Receipt, RotateCcw } from "lucide-react";
import { currencyInfo, expenseSchema, type ExpenseInput } from "@mep/core";
import { useCategories, useExpenseMutations, useExpenses, type ExpenseListItem } from "../../repositories/expenses";
import { useProjects } from "../../repositories/projects";
import { useCurrencyRates } from "../../repositories/currencies";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { usePeopleMutations } from "../../repositories/people";
import { DataTable, type Column } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { KpiCard } from "../../components/KpiCard";
import { Button, DateInput, Field, Input, Modal, PageHeader, Select } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { minorToInput, todayIso, useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";
import type { SavedViewFilters } from "../../lib/savedViews";
import { expenseSectionKpis, parseFinanceScope, resetFinanceScopeParams } from "../finance/financeSectionModel";
import { open } from "@tauri-apps/plugin-dialog";

export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: expenses = [], isLoading } = useExpenses();
  const { data: categories = [] } = useCategories();
  const { data: financials } = useWorkspaceFinancials();
  const mutations = useExpenseMutations();
  const peopleMutations = usePeopleMutations();

  const [categoryFilter, setCategoryFilter] = useState(0);
  // The project-workspace shortcut lands here with ?projectId=; it seeds the
  // regular project filter so there is exactly one filtering control.
  const [projectFilter, setProjectFilter] = useState<"" | "overhead" | number>(
    () => parseFinanceScope(searchParams, "expenses").projectId ?? "",
  );
  const [editing, setEditing] = useState<ExpenseListItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<ExpenseListItem | null>(null);
  const { data: projects = [] } = useProjects();

  const kpis = expenseSectionKpis(
    financials?.allExpenses ?? [],
    typeof projectFilter === "number" ? projectFilter : null,
    todayIso(),
  );

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
    { key: "currency", header: t("common.currency"), value: (e) => e.currency, width: "90px" },
    {
      key: "amount",
      header: t("common.amount"),
      value: (e) => e.amountMinor,
      exportValue: (e) => minorToInput(e.amountMinor, currencyInfo(e.currency).exponent),
      render: (e) => <span className="font-medium tnum">{fmt.money(e.amountMinor, e.currency)}</span>,
      align: "end",
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      width: "170px",
      render: (e) =>
        e.personPaymentId !== null ? (
          <div className="flex justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
            <Button
              variant="ghost"
              className="!text-red-600"
              title={t("expenses.reverseTeamPayment")}
              aria-label={t("expenses.reverseTeamPayment")}
              onClick={() => setDeleting(e)}
            >
              <RotateCcw size={14} />
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
            <Button variant="ghost" onClick={() => setEditing(e)}>{t("common.edit")}</Button>
            <Button variant="ghost" className="!text-red-600" onClick={() => setDeleting(e)}>{t("lifecycle.voidExpense")}</Button>
          </div>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("expenses.title")}
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus size={16} aria-hidden="true" /> {t("expenses.newExpense")}
          </Button>
        }
      />

      {financials && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t("financeSection.kpis")}>
          <KpiCard
            label={t("financeSection.totalSpend")}
            value={base.format(kpis.totalEgp)}
            icon={Receipt}
            hint={t("dashboard.reportingCurrency", { currency: base.code })}
          />
          <KpiCard
            label={t("financeSection.spendMonth")}
            value={base.format(kpis.monthEgp)}
            icon={CalendarDays}
          />
          <KpiCard
            label={t("financeSection.projectSpend")}
            value={base.format(kpis.projectEgp)}
            icon={FolderKanban}
          />
          <KpiCard
            label={t("financeSection.overheadSpend")}
            value={base.format(kpis.overheadEgp)}
            icon={Building2}
          />
        </div>
      )}

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(e) => e.id}
        loading={isLoading}
        emptyMessage={t("common.empty")}
        exportName="expenses"
        viewKey="expenses"
        // `projectId` is the finance-wide saved-view key for project scope.
        // Expenses keeps the scope in local state rather than the URL (its
        // project control also offers "overhead", which is not a project id),
        // but the key name stays the same across the finance section.
        filters={{
          category: categoryFilter ? String(categoryFilter) : "",
          projectId: projectFilter === "" ? "" : String(projectFilter),
        }}
        onApplyFilters={(next: SavedViewFilters) => {
          const category = Number(next.category);
          setCategoryFilter(
            Number.isSafeInteger(category) && categories.some((c) => c.id === category) ? category : 0,
          );
          const project = next.projectId ?? "";
          if (project === "overhead") setProjectFilter("overhead");
          else {
            const id = Number(project);
            setProjectFilter(Number.isSafeInteger(id) && id > 0 ? id : "");
          }
        }}
        onResetFilters={() => {
          setCategoryFilter(0);
          setProjectFilter("");
          // The seeding parameter must go too, or a reset re-seeds on remount.
          setSearchParams(resetFinanceScopeParams(searchParams), { replace: true });
        }}
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
          title={deleting.personPaymentId !== null ? t("expenses.reverseTeamPayment") : t("lifecycle.voidExpense")}
          confirmLabel={deleting.personPaymentId !== null ? t("lifecycle.reverse") : t("lifecycle.void")}
          requireReason={deleting.personPaymentId === null}
          message={`${deleting.personPaymentId !== null ? t("expenses.confirmReverseTeamPayment") : t("lifecycle.confirmVoidExpense")} (${deleting.description})`}
          busy={mutations.remove.isPending || peopleMutations.removePersonPayment.isPending}
          error={
            mutations.remove.isError
              ? (mutations.remove.error as Error).message === "EXPENSE_NOT_FOUND_VOIDED_OR_LINKED"
                ? t("expenses.linkedExpenseUseTeamPayment")
                : (mutations.remove.error as Error).message
              : peopleMutations.removePersonPayment.isError
                ? (peopleMutations.removePersonPayment.error as Error).message
                : undefined
          }
          onCancel={() => {
            mutations.remove.reset();
            peopleMutations.removePersonPayment.reset();
            setDeleting(null);
          }}
          onConfirm={(reason) => {
            if (deleting.personPaymentId !== null) {
              peopleMutations.removePersonPayment.mutate(deleting.personPaymentId, { onSuccess: () => setDeleting(null) });
            } else {
              mutations.remove.mutate({ id: deleting.id, reason }, { onSuccess: () => setDeleting(null) });
            }
          }}
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
          <DateInput value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
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
