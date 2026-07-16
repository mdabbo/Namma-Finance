import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecurringExpense, RecurringExpenseInput } from "@mep/core";
import { execute, select } from "../lib/db";
import { todayIso } from "../lib/format";

interface RecurringRow {
  id: number;
  name: string;
  category_id: number;
  amount_minor: number;
  currency: string;
  fx_rate_micro: number;
  day_of_month: number;
  is_active: number;
  notes: string | null;
  created_at: string;
}

function mapRecurring(r: RecurringRow): RecurringExpense {
  return {
    id: r.id,
    name: r.name,
    categoryId: r.category_id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    fxRateMicro: r.fx_rate_micro,
    dayOfMonth: r.day_of_month,
    isActive: r.is_active === 1,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

export async function listRecurring(): Promise<RecurringExpense[]> {
  const rows = await select<RecurringRow>("SELECT * FROM recurring_expenses ORDER BY name COLLATE NOCASE");
  return rows.map(mapRecurring);
}

export async function createRecurring(input: RecurringExpenseInput): Promise<number> {
  const r = await execute(
    `INSERT INTO recurring_expenses (name, category_id, amount_minor, currency, fx_rate_micro, day_of_month, is_active, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.name, input.categoryId, input.amountMinor, input.currency, input.fxRateMicro,
     input.dayOfMonth, input.isActive ? 1 : 0, input.notes ?? null],
  );
  return r.lastInsertId ?? 0;
}

export async function updateRecurring(id: number, input: RecurringExpenseInput): Promise<void> {
  await execute(
    `UPDATE recurring_expenses SET name=$1, category_id=$2, amount_minor=$3, currency=$4,
        fx_rate_micro=$5, day_of_month=$6, is_active=$7, notes=$8
     WHERE id=$9`,
    [input.name, input.categoryId, input.amountMinor, input.currency, input.fxRateMicro,
     input.dayOfMonth, input.isActive ? 1 : 0, input.notes ?? null, id],
  );
}

export async function deleteRecurring(id: number): Promise<void> {
  await execute("DELETE FROM recurring_expenses WHERE id = $1", [id]);
}

/** Post this month's occurrence as a real (overhead) expense. */
export async function recordRecurringNow(item: RecurringExpense): Promise<void> {
  await execute(
    `INSERT INTO expenses (date, category_id, description, project_id, supplier, amount_minor, currency, fx_rate_micro)
     VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6)`,
    [todayIso(), item.categoryId, item.name, item.amountMinor, item.currency, item.fxRateMicro],
  );
}

export function useRecurring() {
  return useQuery({ queryKey: ["recurring"], queryFn: listRecurring });
}

export function useRecurringMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["recurring"] });
    void qc.invalidateQueries({ queryKey: ["expenses"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
  };
  return {
    create: useMutation({ mutationFn: createRecurring, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: (v: { id: number; input: RecurringExpenseInput }) => updateRecurring(v.id, v.input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteRecurring, onSuccess: invalidate }),
    recordNow: useMutation({ mutationFn: recordRecurringNow, onSuccess: invalidate }),
  };
}
