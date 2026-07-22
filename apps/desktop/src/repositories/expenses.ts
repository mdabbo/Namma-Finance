import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Expense, ExpenseCategory, ExpenseInput } from "@mep/core";
import { execute, select } from "../lib/db";

interface ExpenseRow {
  id: number;
  number: string | null;
  date: string;
  category_id: number;
  description: string;
  project_id: number | null;
  supplier: string | null;
  amount_minor: number;
  currency: string;
  fx_rate_micro: number;
  attachment_path: string | null;
  person_payment_id?: number | null;
  created_at: string;
  category_en?: string;
  category_ar?: string;
  project_name?: string | null;
  project_code?: string | null;
}

export interface ExpenseListItem extends Expense {
  number: string;
  categoryEn: string;
  categoryAr: string;
  projectName: string | null;
  projectCode: string | null;
  /** Set when this expense was auto-created from a team payment (read-only in UI). */
  personPaymentId: number | null;
}

function mapExpense(r: ExpenseRow): ExpenseListItem {
  return {
    id: r.id,
    number: r.number ?? "",
    date: r.date,
    categoryId: r.category_id,
    description: r.description,
    projectId: r.project_id,
    supplier: r.supplier,
    amountMinor: r.amount_minor,
    currency: r.currency,
    fxRateMicro: r.fx_rate_micro,
    attachmentPath: r.attachment_path,
    createdAt: r.created_at,
    categoryEn: r.category_en ?? "",
    categoryAr: r.category_ar ?? "",
    projectName: r.project_name ?? null,
    projectCode: r.project_code ?? null,
    personPaymentId: r.person_payment_id ?? null,
  };
}

export async function listExpenses(): Promise<ExpenseListItem[]> {
  const rows = await select<ExpenseRow>(
    `SELECT e.*, ec.name_en AS category_en, ec.name_ar AS category_ar, p.name AS project_name, p.code AS project_code
     FROM expenses e
     JOIN expense_categories ec ON ec.id = e.category_id
     LEFT JOIN projects p ON p.id = e.project_id
     WHERE e.voided_at IS NULL AND e.archived_at IS NULL
     ORDER BY e.date DESC, e.id DESC`,
  );
  return rows.map(mapExpense);
}

export async function listExpensesByProject(projectId: number): Promise<ExpenseListItem[]> {
  const rows = await select<ExpenseRow>(
    `SELECT e.*, ec.name_en AS category_en, ec.name_ar AS category_ar, p.name AS project_name, p.code AS project_code
     FROM expenses e
     JOIN expense_categories ec ON ec.id = e.category_id
     LEFT JOIN projects p ON p.id = e.project_id
     WHERE e.project_id = $1 AND e.voided_at IS NULL AND e.archived_at IS NULL
     ORDER BY e.date DESC, e.id DESC`,
    [projectId],
  );
  return rows.map(mapExpense);
}

export async function createExpense(input: ExpenseInput): Promise<number> {
  const { reserveNextNumber } = await import("./numbering");
  const { loadSettings } = await import("../lib/settings");
  const number = await reserveNextNumber("EXPENSE", (await loadSettings()).expenseNumberPrefix, new Date(`${input.date}T00:00:00Z`));
  const r = await execute(
    `INSERT INTO expenses (number,date, category_id, description, project_id, supplier, amount_minor, currency, fx_rate_micro, attachment_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [number,input.date, input.categoryId, input.description, input.projectId ?? null, input.supplier ?? null,
     input.amountMinor, input.currency, input.fxRateMicro, input.attachmentPath ?? null],
  );
  return r.lastInsertId ?? 0;
}

export async function updateExpense(id: number, input: ExpenseInput): Promise<void> {
  await execute(
    `UPDATE expenses SET date=$1, category_id=$2, description=$3, project_id=$4, supplier=$5,
        amount_minor=$6, currency=$7, fx_rate_micro=$8, attachment_path=$9
     WHERE id=$10`,
    [input.date, input.categoryId, input.description, input.projectId ?? null, input.supplier ?? null,
     input.amountMinor, input.currency, input.fxRateMicro, input.attachmentPath ?? null, id],
  );
}

export async function deleteExpense(id: number): Promise<void> {
  const result = await execute("UPDATE expenses SET voided_at=datetime('now'), void_reason='Voided by user' WHERE id=$1 AND voided_at IS NULL AND person_payment_id IS NULL", [id]);
  if (result.rowsAffected !== 1) throw new Error("EXPENSE_NOT_FOUND_VOIDED_OR_LINKED");
}

// --- categories ---

export async function listCategories(includeInactive = false): Promise<ExpenseCategory[]> {
  const rows = await select<{ id: number; name_en: string; name_ar: string; is_active: number; sort_order: number }>(
    `SELECT * FROM expense_categories ${includeInactive ? "" : "WHERE is_active = 1"} ORDER BY sort_order, id`,
  );
  return rows.map((r) => ({ id: r.id, nameEn: r.name_en, nameAr: r.name_ar, isActive: r.is_active === 1, sortOrder: r.sort_order }));
}

export async function createCategory(nameEn: string, nameAr: string): Promise<void> {
  await execute(
    "INSERT INTO expense_categories (name_en, name_ar, sort_order) VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order),0)+1 FROM expense_categories))",
    [nameEn, nameAr],
  );
}

export async function updateCategory(id: number, nameEn: string, nameAr: string, isActive: boolean): Promise<void> {
  await execute("UPDATE expense_categories SET name_en=$1, name_ar=$2, is_active=$3 WHERE id=$4", [
    nameEn, nameAr, isActive ? 1 : 0, id,
  ]);
}

export async function deleteCategory(id: number): Promise<{ ok: boolean }> {
  const used = await select<{ n: number }>("SELECT COUNT(*) AS n FROM expenses WHERE category_id=$1", [id]);
  if ((used[0]?.n ?? 0) > 0) return { ok: false }; // in use → deactivate instead
  await execute("DELETE FROM expense_categories WHERE id=$1", [id]);
  return { ok: true };
}

export function useExpenses() {
  return useQuery({ queryKey: ["expenses"], queryFn: listExpenses });
}
export function useExpensesByProject(projectId: number) {
  return useQuery({ queryKey: ["expenses", "project", projectId], queryFn: () => listExpensesByProject(projectId) });
}
export function useCategories(includeInactive = false) {
  return useQuery({ queryKey: ["expense-categories", includeInactive], queryFn: () => listCategories(includeInactive) });
}

export function useExpenseMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["expenses"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
    void qc.invalidateQueries({ queryKey: ["expense-categories"] });
  };
  return {
    create: useMutation({ mutationFn: createExpense, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: (v: { id: number; input: ExpenseInput }) => updateExpense(v.id, v.input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteExpense, onSuccess: invalidate }),
    createCategory: useMutation({
      mutationFn: (v: { nameEn: string; nameAr: string }) => createCategory(v.nameEn, v.nameAr),
      onSuccess: invalidate,
    }),
    updateCategory: useMutation({
      mutationFn: (v: { id: number; nameEn: string; nameAr: string; isActive: boolean }) =>
        updateCategory(v.id, v.nameEn, v.nameAr, v.isActive),
      onSuccess: invalidate,
    }),
    removeCategory: useMutation({ mutationFn: deleteCategory, onSuccess: invalidate }),
  };
}
