import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Receipt, Trash2 } from "lucide-react";
import { Bar, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  buildCashflow,
  isBillable,
  recurringExpenseSchema,
  toEgpPiasters,
  type RecurringExpense,
  type RecurringExpenseInput,
} from "@mep/core";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useRecurring, useRecurringMutations } from "../../repositories/recurring";
import { useCategories } from "../../repositories/expenses";
import { Button, Card, EmptyState, Field, Input, Modal, Select, cx } from "../../components/ui";
import { MoneyInput } from "../../components/MoneyInput";
import { todayIso, useFormat } from "../../lib/format";
import { useBaseMoney } from "../../lib/baseCurrency";

export function CashflowView() {
  const { t, i18n } = useTranslation();
  const base = useBaseMoney();
  const { data: financials } = useWorkspaceFinancials();
  const { data: recurring = [] } = useRecurring();

  const rows = useMemo(() => {
    if (!financials) return [];
    const actualOut = financials.allExpenses.map((e) => ({
      date: e.date,
      egpMinor: toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro),
    }));
    const openReceivables = [...financials.contractStates.values()].flatMap((state) => {
      const project = financials.projects.find((p) => p.project.id === state.contract.projectId)?.project;
      return state.certificates
        .filter((cs) => isBillable(cs.certificate.status) && cs.unpaidMinor > 0)
        .map((cs) => ({
          dueDate: cs.dueDate,
          unpaidEgp: project ? toEgpPiasters(cs.unpaidMinor, project.currency, project.fxRateMicro) : cs.unpaidMinor,
        }));
    });
    return buildCashflow({
      actualIn: financials.cashIn,
      actualOut,
      openReceivables,
      recurring: recurring
        .filter((r) => r.isActive)
        .map((r) => ({ egpMinor: toEgpPiasters(r.amountMinor, r.currency, r.fxRateMicro), dayOfMonth: r.dayOfMonth })),
      todayIso: todayIso(),
      monthsBack: 6,
      monthsForward: 6,
    });
  }, [financials, recurring]);

  const chartData = rows.map((r) => ({
    month: r.month,
    in: base.convert(r.inActual + r.inForecast) / 100,
    out: -(base.convert(r.outActual + r.outForecast) / 100),
    cumulative: base.convert(r.cumulative) / 100,
  }));

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">{t("reports.forecastNote", { currency: base.code })}</p>

      <Card className="p-4">
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} reversed={i18n.dir() === "rtl"} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => new Intl.NumberFormat("en", { notation: "compact" }).format(Number(v))} orientation={i18n.dir() === "rtl" ? "right" : "left"} />
            <Tooltip formatter={(v) => new Intl.NumberFormat().format(Number(v))} />
            <Legend />
            <Bar dataKey="in" name={t("cash.totalActualCashIn")} fill="#2563eb" radius={[3, 3, 0, 0]} />
            <Bar dataKey="out" name={t("dashboard.cashOut")} fill="#f59e0b" radius={[3, 3, 0, 0]} />
            <Line type="monotone" dataKey="cumulative" name={t("reports.cumulative")} stroke="#10b981" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>

      <Card className="overflow-x-auto p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
              <th className="py-2 text-start">{t("reports.month")}</th>
              <th className="text-end">{t("reports.inActual")}</th>
              <th className="text-end">{t("reports.inForecast")}</th>
              <th className="text-end">{t("reports.outActual")}</th>
              <th className="text-end">{t("reports.outForecast")}</th>
              <th className="text-end">{t("reports.net")}</th>
              <th className="text-end">{t("reports.cumulative")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month} className={cx("border-b border-slate-100 last:border-0 dark:border-slate-800", r.isForecast && "bg-slate-50/70 text-slate-500 dark:bg-slate-800/40")}>
                <td className="py-1.5 tnum">{r.month}</td>
                <td className="text-end tnum">{base.format(r.inActual)}</td>
                <td className="text-end tnum text-brand-600 dark:text-brand-300">{base.format(r.inForecast)}</td>
                <td className="text-end tnum">{base.format(r.outActual)}</td>
                <td className="text-end tnum text-amber-600 dark:text-amber-400">{base.format(r.outForecast)}</td>
                <td className={cx("text-end tnum font-medium", r.net < 0 && "text-red-600")}>{base.format(r.net)}</td>
                <td className={cx("text-end tnum", r.cumulative < 0 && "text-red-600")}>{base.format(r.cumulative)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <RecurringManager />
    </div>
  );
}

function RecurringManager() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const { data: recurring = [] } = useRecurring();
  const { data: categories = [] } = useCategories();
  const mutations = useRecurringMutations();
  const [editing, setEditing] = useState<RecurringExpense | "new" | null>(null);

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Receipt size={15} className="text-slate-400" /> {t("recurring.title")}
        </p>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={14} /> {t("recurring.newItem")}
        </Button>
      </div>
      {recurring.length === 0 ? (
        <EmptyState message={t("common.empty")} />
      ) : (
        <div className="space-y-1">
          {recurring.map((item) => (
            <div key={item.id} className={cx("group flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50", !item.isActive && "opacity-50")}>
              <button className="flex-1 truncate text-start font-medium hover:text-brand-600" onClick={() => setEditing(item)}>
                {item.name}
              </button>
              <span className="text-xs text-slate-400">
                {(() => {
                  const cat = categories.find((c) => c.id === item.categoryId);
                  return cat ? (i18n.language === "ar" ? cat.nameAr : cat.nameEn) : "";
                })()}
              </span>
              <span className="text-xs text-slate-400 tnum">{t("recurring.dayOfMonth")}: {item.dayOfMonth}</span>
              <span className="w-32 text-end font-medium tnum">{fmt.money(item.amountMinor, item.currency, { compactFraction: true })}</span>
              <Button variant="ghost" onClick={() => mutations.recordNow.mutate(item)}>{t("recurring.recordNow")}</Button>
              <button className="text-slate-300 opacity-0 hover:text-red-600 group-hover:opacity-100" onClick={() => mutations.remove.mutate(item.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <RecurringForm
          initial={editing === "new" ? null : editing}
          busy={mutations.create.isPending || mutations.update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            if (editing === "new") mutations.create.mutate(input, { onSuccess: () => setEditing(null) });
            else mutations.update.mutate({ id: editing.id, input }, { onSuccess: () => setEditing(null) });
          }}
        />
      )}
    </Card>
  );
}

function RecurringForm({
  initial,
  onSubmit,
  onClose,
  busy,
}: {
  initial: RecurringExpense | null;
  onSubmit: (input: RecurringExpenseInput) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { data: categories = [] } = useCategories();
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    categoryId: initial?.categoryId ?? 0,
    amountMinor: initial?.amountMinor ?? 0,
    currency: initial?.currency ?? "EGP",
    fxRateMicro: initial?.fxRateMicro ?? 1_000_000,
    dayOfMonth: initial?.dayOfMonth ?? 1,
    isActive: initial?.isActive ?? true,
    notes: initial?.notes ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit() {
    const parsed = recurringExpenseSchema.safeParse({ ...form, notes: form.notes || null });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0])] = t(`validation.${issue.message}`, issue.message);
      setErrors(errs);
      return;
    }
    onSubmit(parsed.data);
  }

  return (
    <Modal title={initial ? t("common.edit") : t("recurring.newItem")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("common.name")} error={errors.name} className="col-span-2">
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
        </Field>
        <Field label={t("expenses.category")} error={errors.categoryId}>
          <Select value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: Number(e.target.value) }))}>
            <option value={0}>—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{i18n.language === "ar" ? c.nameAr : c.nameEn}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("common.amount")} error={errors.amountMinor}>
          <MoneyInput currency={form.currency} valueMinor={form.amountMinor} onChange={(v) => setForm((f) => ({ ...f, amountMinor: v ?? 0 }))} />
        </Field>
        <Field label={t("recurring.dayOfMonth")}>
          <Input
            dir="ltr"
            type="number"
            min={1}
            max={31}
            className="text-end tnum"
            value={form.dayOfMonth}
            onChange={(e) => setForm((f) => ({ ...f, dayOfMonth: Math.min(31, Math.max(1, Number(e.target.value) || 1)) }))}
          />
        </Field>
        <Field label={t("common.status")}>
          <Select value={form.isActive ? "1" : "0"} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === "1" }))}>
            <option value="1">{t("people.active")}</option>
            <option value="0">{t("people.inactive")}</option>
          </Select>
        </Field>
        <Field label={t("common.notes")} className="col-span-2">
          <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{t("common.save")}</Button>
      </div>
    </Modal>
  );
}
