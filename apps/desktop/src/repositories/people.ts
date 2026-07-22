import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { AssignmentInput, Person, PersonInput, PersonPayment, PersonPaymentInput, ProjectAssignment } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";

interface PersonRow {
  id: number;
  type: Person["type"];
  name: string;
  specialization: string | null;
  phone: string | null;
  email: string | null;
  bank_account: string | null;
  hourly_rate_minor: number | null;
  monthly_rate_minor: number | null;
  currency: string;
  notes: string | null;
  is_active: number;
  created_at: string;
  archived_at: string | null;
}

export type PersonListItem = Person & { archivedAt: string | null };

function mapPerson(r: PersonRow): PersonListItem {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    specialization: r.specialization,
    phone: r.phone,
    email: r.email,
    bankAccount: r.bank_account,
    hourlyRateMinor: r.hourly_rate_minor,
    monthlyRateMinor: r.monthly_rate_minor,
    currency: r.currency,
    notes: r.notes,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

export async function listPeople(includeArchived = false): Promise<PersonListItem[]> {
  const rows = await select<PersonRow>(`SELECT * FROM people ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY name COLLATE NOCASE`);
  return rows.map(mapPerson);
}

export async function getPerson(id: number): Promise<Person | null> {
  const row = await selectOne<PersonRow>("SELECT * FROM people WHERE id=$1 AND archived_at IS NULL", [id]);
  return row ? mapPerson(row) : null;
}

export async function createPerson(input: PersonInput): Promise<number> {
  const r = await execute(
    `INSERT INTO people (type, name, specialization, phone, email, bank_account, hourly_rate_minor, monthly_rate_minor, currency, notes, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.type, input.name, input.specialization ?? null, input.phone ?? null, input.email ?? null,
     input.bankAccount ?? null, input.hourlyRateMinor ?? null, input.monthlyRateMinor ?? null,
     input.currency, input.notes ?? null, input.isActive ? 1 : 0],
  );
  return r.lastInsertId ?? 0;
}

export async function updatePerson(id: number, input: PersonInput): Promise<void> {
  await execute(
    `UPDATE people SET type=$1, name=$2, specialization=$3, phone=$4, email=$5, bank_account=$6,
        hourly_rate_minor=$7, monthly_rate_minor=$8, currency=$9, notes=$10, is_active=$11
     WHERE id=$12`,
    [input.type, input.name, input.specialization ?? null, input.phone ?? null, input.email ?? null,
     input.bankAccount ?? null, input.hourlyRateMinor ?? null, input.monthlyRateMinor ?? null,
     input.currency, input.notes ?? null, input.isActive ? 1 : 0, id],
  );
}

export async function deletePerson(id: number): Promise<void> {
  const result = await execute("UPDATE people SET archived_at=datetime('now'), archive_reason='Archived by user' WHERE id=$1 AND archived_at IS NULL", [id]);
  if (result.rowsAffected !== 1) throw new Error("PERSON_NOT_FOUND_OR_ARCHIVED");
}

// --- assignments ---

interface AssignmentRow {
  id: number;
  person_id: number;
  project_id: number;
  agreed_minor: number;
  currency: string;
  fx_rate_micro: number;
  scope: string | null;
  progress_note: string | null;
  created_at: string;
  project_name?: string;
  project_code?: string;
  person_name?: string;
}

export interface AssignmentListItem extends ProjectAssignment {
  projectName: string;
  projectCode: string;
  personName: string;
}

function mapAssignment(r: AssignmentRow): AssignmentListItem {
  return {
    id: r.id,
    personId: r.person_id,
    projectId: r.project_id,
    agreedMinor: r.agreed_minor,
    currency: r.currency,
    fxRateMicro: r.fx_rate_micro,
    scope: r.scope,
    progressNote: r.progress_note,
    createdAt: r.created_at,
    projectName: r.project_name ?? "",
    projectCode: r.project_code ?? "",
    personName: r.person_name ?? "",
  };
}

const ASSIGNMENT_SQL = `
  SELECT a.*, p.name AS project_name, p.code AS project_code, pe.name AS person_name
  FROM project_assignments a
  JOIN projects p ON p.id = a.project_id
  JOIN people pe ON pe.id = a.person_id`;

export async function listAllAssignments(): Promise<AssignmentListItem[]> {
  const rows = await select<AssignmentRow>(`${ASSIGNMENT_SQL} WHERE a.archived_at IS NULL ORDER BY a.created_at DESC`);
  return rows.map(mapAssignment);
}

export async function listAllPersonPayments(): Promise<PersonPayment[]> {
  const rows = await select<{ id: number; assignment_id: number; date: string; amount_minor: number; note: string | null; created_at: string }>(
    "SELECT * FROM person_payments WHERE voided_at IS NULL ORDER BY date",
  );
  return rows.map((r) => ({
    id: r.id, assignmentId: r.assignment_id, date: r.date, amountMinor: r.amount_minor,
    note: r.note, createdAt: r.created_at,
  }));
}

export async function listAssignmentsByPerson(personId: number): Promise<AssignmentListItem[]> {
  const rows = await select<AssignmentRow>(`${ASSIGNMENT_SQL} WHERE a.person_id = $1 AND a.archived_at IS NULL ORDER BY a.created_at DESC`, [personId]);
  return rows.map(mapAssignment);
}

export async function listAssignmentsByProject(projectId: number): Promise<AssignmentListItem[]> {
  const rows = await select<AssignmentRow>(`${ASSIGNMENT_SQL} WHERE a.project_id = $1 AND a.archived_at IS NULL ORDER BY a.created_at DESC`, [projectId]);
  return rows.map(mapAssignment);
}

export async function createAssignment(input: AssignmentInput): Promise<number> {
  const r = await execute(
    `INSERT INTO project_assignments (person_id, project_id, agreed_minor, currency, fx_rate_micro, scope, progress_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.personId, input.projectId, input.agreedMinor, input.currency, input.fxRateMicro,
     input.scope ?? null, input.progressNote ?? null],
  );
  return r.lastInsertId ?? 0;
}

export async function updateAssignment(id: number, input: AssignmentInput): Promise<void> {
  await execute(
    `UPDATE project_assignments SET agreed_minor=$1, currency=$2, fx_rate_micro=$3, scope=$4, progress_note=$5
     WHERE id=$6`,
    [input.agreedMinor, input.currency, input.fxRateMicro, input.scope ?? null, input.progressNote ?? null, id],
  );
}

export async function deleteAssignment(id: number): Promise<void> {
  const result = await execute("UPDATE project_assignments SET archived_at=datetime('now'), archive_reason='Archived by user' WHERE id=$1 AND archived_at IS NULL", [id]);
  if (result.rowsAffected !== 1) throw new Error("ASSIGNMENT_NOT_FOUND_OR_ARCHIVED");
}

// --- person payments ---

export async function listPersonPayments(assignmentIds: number[]): Promise<PersonPayment[]> {
  if (assignmentIds.length === 0) return [];
  const placeholders = assignmentIds.map((_, i) => `$${i + 1}`).join(",");
  const rows = await select<{ id: number; assignment_id: number; date: string; amount_minor: number; note: string | null; created_at: string }>(
    `SELECT * FROM person_payments WHERE assignment_id IN (${placeholders}) AND voided_at IS NULL ORDER BY date, id`,
    assignmentIds,
  );
  return rows.map((r) => ({
    id: r.id, assignmentId: r.assignment_id, date: r.date, amountMinor: r.amount_minor,
    note: r.note, createdAt: r.created_at,
  }));
}

/**
 * Recording a team payment ALSO records a project expense (confirmed rule):
 * the expense carries person_payment_id, so deleting the payment removes the
 * expense automatically (FK cascade), and project net profit — which is
 * revenue − expenses — always includes team costs.
 */
export async function createPersonPayment(input: PersonPaymentInput): Promise<number> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return invoke<number>("create_person_payment_atomic", { input });
  }
  await execute("BEGIN IMMEDIATE");
  try {
  // guard against accidental double-recording (double-click, repeated "Pay"):
  // an EXACT twin — same assignment, date, amount and note — is rejected;
  // change the date or note to record a genuine second payment
  const twin = await selectOne<{ id: number }>(
    "SELECT id FROM person_payments WHERE assignment_id=$1 AND date=$2 AND amount_minor=$3 AND note IS $4 AND voided_at IS NULL LIMIT 1",
    [input.assignmentId, input.date, input.amountMinor, input.note ?? null],
  );
  if (twin) throw new Error("DUPLICATE_PERSON_PAYMENT");

  const r = await execute(
    "INSERT INTO person_payments (assignment_id, date, amount_minor, note) VALUES ($1,$2,$3,$4)",
    [input.assignmentId, input.date, input.amountMinor, input.note ?? null],
  );
  const paymentId = r.lastInsertId ?? 0;

  const ctx = await selectOne<{
    project_id: number;
    currency: string;
    fx_rate_micro: number;
    person_name: string;
    person_type: string;
  }>(
    `SELECT a.project_id, a.currency, a.fx_rate_micro, pe.name AS person_name, pe.type AS person_type
     FROM project_assignments a JOIN people pe ON pe.id = a.person_id
     WHERE a.id = $1`,
    [input.assignmentId],
  );
  if (!ctx) throw new Error("ASSIGNMENT_NOT_FOUND");
    const categoryName = ctx.person_type === "EMPLOYEE" ? "Salaries" : "Freelancers";
    const category = await selectOne<{ id: number }>(
      "SELECT id FROM expense_categories WHERE name_en = $1 ORDER BY id LIMIT 1",
      [categoryName],
    );
    const fallback = category ?? (await selectOne<{ id: number }>("SELECT id FROM expense_categories ORDER BY sort_order, id LIMIT 1"));
    if (!fallback) throw new Error("EXPENSE_CATEGORY_NOT_FOUND");
      await execute(
        `INSERT INTO expenses (date, category_id, description, project_id, supplier, amount_minor,
            currency, fx_rate_micro, person_payment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [input.date, fallback.id, input.note ? `${ctx.person_name} — ${input.note}` : ctx.person_name,
         ctx.project_id, ctx.person_name, input.amountMinor, ctx.currency, ctx.fx_rate_micro, paymentId],
      );
    await execute("COMMIT");
    return paymentId;
  } catch (error) {
    await execute("ROLLBACK");
    throw error;
  }
}

/** Reverse a team payment without destroying either financial record. */
export async function deletePersonPayment(id: number): Promise<void> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await invoke("delete_person_payment_atomic", { paymentId: id });
    return;
  }
  await execute("BEGIN IMMEDIATE");
  try {
    const result = await execute("UPDATE person_payments SET voided_at=datetime('now'), void_reason='Reversed by user' WHERE id=$1 AND voided_at IS NULL", [id]);
    if (result.rowsAffected !== 1) throw new Error("PERSON_PAYMENT_NOT_FOUND");
    const reversal = await execute(
      `INSERT INTO person_payments (assignment_id,date,amount_minor,note,voided_at,void_reason,reversal_of_id)
       SELECT assignment_id,date,amount_minor,note,datetime('now'),'Reversal record',id FROM person_payments WHERE id=$1`,
      [id],
    );
    const reversalId = reversal.lastInsertId ?? 0;
    const originalExpense = await selectOne<{ id: number }>("SELECT id FROM expenses WHERE person_payment_id=$1 AND voided_at IS NULL", [id]);
    if (!originalExpense) throw new Error("LINKED_EXPENSE_REVERSAL_FAILED");
    const expense = await execute("UPDATE expenses SET voided_at=datetime('now'), void_reason='Reversed with person payment' WHERE id=$1 AND voided_at IS NULL", [originalExpense.id]);
    if (expense.rowsAffected !== 1) throw new Error("LINKED_EXPENSE_REVERSAL_FAILED");
    await execute(
      `INSERT INTO expenses (date,category_id,description,project_id,supplier,amount_minor,currency,fx_rate_micro,attachment_path,person_payment_id,voided_at,void_reason,reversal_of_id)
       SELECT date,category_id,description,project_id,supplier,amount_minor,currency,fx_rate_micro,attachment_path,$1,datetime('now'),'Reversal record',id FROM expenses WHERE id=$2`,
      [reversalId, originalExpense.id],
    );
    await execute("COMMIT");
  } catch (error) {
    await execute("ROLLBACK");
    throw error;
  }
}

export function usePeople(includeArchived = false) {
  return useQuery({ queryKey: ["people", includeArchived], queryFn: () => listPeople(includeArchived) });
}
export function usePerson(id: number) {
  return useQuery({ queryKey: ["people", id], queryFn: () => getPerson(id) });
}
export function useAssignmentsByPerson(personId: number) {
  return useQuery({ queryKey: ["assignments", "person", personId], queryFn: () => listAssignmentsByPerson(personId) });
}
export function useAssignmentsByProject(projectId: number) {
  return useQuery({ queryKey: ["assignments", "project", projectId], queryFn: () => listAssignmentsByProject(projectId) });
}
export function usePersonPayments(assignmentIds: number[]) {
  return useQuery({
    queryKey: ["person-payments", assignmentIds],
    queryFn: () => listPersonPayments(assignmentIds),
    enabled: assignmentIds.length > 0,
  });
}

export function usePeopleMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["people"] });
    void qc.invalidateQueries({ queryKey: ["assignments"] });
    void qc.invalidateQueries({ queryKey: ["person-payments"] });
    // team payments create/remove linked expenses → financials change too
    void qc.invalidateQueries({ queryKey: ["expenses"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
  };
  return {
    create: useMutation({ mutationFn: createPerson, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: (v: { id: number; input: PersonInput }) => updatePerson(v.id, v.input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deletePerson, onSuccess: invalidate }),
    createAssignment: useMutation({ mutationFn: createAssignment, onSuccess: invalidate }),
    updateAssignment: useMutation({
      mutationFn: (v: { id: number; input: AssignmentInput }) => updateAssignment(v.id, v.input),
      onSuccess: invalidate,
    }),
    removeAssignment: useMutation({ mutationFn: deleteAssignment, onSuccess: invalidate }),
    createPersonPayment: useMutation({ mutationFn: createPersonPayment, onSuccess: invalidate }),
    removePersonPayment: useMutation({ mutationFn: deletePersonPayment, onSuccess: invalidate }),
  };
}
