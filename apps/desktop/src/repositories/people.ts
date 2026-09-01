import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssignmentInput, AssignmentLifecycle, Person, PersonInput, PersonPayment, PersonPaymentInput, ProjectAssignment } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";
import { atomicCommand } from "../lib/atomic";
import { withLock } from "../lib/mutex";

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

/** Archive (soft): the person is hidden but their assignments and payments remain. */
export async function deletePerson(id: number, reason?: string): Promise<void> {
  const result = await execute(
    "UPDATE people SET archived_at=datetime('now'), archive_reason=$2 WHERE id=$1 AND archived_at IS NULL",
    [id, reason?.trim() || "Archived by user"],
  );
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
  lifecycle_status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  earned_minor_at_cancellation: number | null;
  archived_at: string | null;
  project_name?: string;
  project_code?: string;
  person_name?: string;
  person_archived_at?: string | null;
}

export interface AssignmentListItem extends ProjectAssignment {
  projectName: string;
  projectCode: string;
  personName: string;
  /** Archiving the person also silences the assignment's alerts. */
  personArchived: boolean;
}

export interface SyncedAssignmentInput {
  localId: number | null;
  syncUuid: string;
  updatedAt: string;
  personId: number;
  projectId: number;
  agreedMinor: number;
  currency: string;
  fxRateMicro: number;
  scope: string | null;
  progressNote: string | null;
  createdAt: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  archiveReason: string | null;
  lifecycleStatus: AssignmentLifecycle;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  earnedMinorAtCancellation: number | null;
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
    lifecycleStatus: r.lifecycle_status,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    cancellationReason: r.cancellation_reason,
    earnedMinorAtCancellation: r.earned_minor_at_cancellation,
    archivedAt: r.archived_at,
    projectName: r.project_name ?? "",
    projectCode: r.project_code ?? "",
    personName: r.person_name ?? "",
    personArchived: (r.person_archived_at ?? null) !== null,
  };
}

const ASSIGNMENT_SQL = `
  SELECT a.*, p.name AS project_name, p.code AS project_code, pe.name AS person_name,
         pe.archived_at AS person_archived_at
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

/**
 * Mark the agreed scope finished. Unpaid earned value stays payable, because
 * finishing the work does not mean the client has paid for it yet.
 */
export async function completeAssignment(id: number): Promise<void> {
  const result = await execute(
    `UPDATE project_assignments SET lifecycle_status='COMPLETED', completed_at=datetime('now')
     WHERE id=$1 AND lifecycle_status='ACTIVE'`,
    [id],
  );
  if (result.rowsAffected !== 1) throw new Error("ASSIGNMENT_NOT_ACTIVE");
}

/**
 * Call off the remaining scope. Earned value is frozen at this moment so
 * certificates the client pays later cannot accrue to work that stopped, and
 * the unearned remainder leaves the project's committed cost. A reason is
 * required: removing a commitment is an accounting decision.
 */
export function cancelAssignment(id: number, reason: string): Promise<void> {
  // The frozen figure is DERIVED by `cancel_assignment_atomic`, from stored
  // evidence, inside the transaction that writes it — nothing is sent from here
  // for Rust to trust. It used to be computed in this process and passed as an
  // argument that Rust could only bound-check, so a wrong value could look
  // plausible and migration 0004 would then make it final.
  //
  // The lock still serialises this against payments and collections in the same
  // process, which keeps the read model consistent for whatever the UI shows
  // next.
  return withLock(() => cancelAssignmentUnlocked(id, reason));
}

async function cancelAssignmentUnlocked(id: number, reason: string): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("CANCELLATION_REASON_REQUIRED");
  await atomicCommand<void>(
    "cancel_assignment_atomic",
    { assignmentId: id, reason: trimmed },
    async () => {
      const assignment = await selectOne<{ agreedMinor: number; lifecycleStatus: string; projectArchivedAt: string | null }>(
        `SELECT a.agreed_minor AS agreedMinor, a.lifecycle_status AS lifecycleStatus,
                p.archived_at AS projectArchivedAt
         FROM project_assignments a JOIN projects p ON p.id=a.project_id WHERE a.id=$1`,
        [id],
      );
      if (!assignment) throw new Error("ASSIGNMENT_NOT_FOUND");
      if (assignment.lifecycleStatus === "CANCELLED") throw new Error("ASSIGNMENT_ALREADY_CANCELLED");
      if (assignment.projectArchivedAt !== null) throw new Error("PROJECT_ARCHIVED");
      // The double derives it the same way the command does, from the same
      // evidence — `computeTeamPayout` is the reference the Rust port mirrors.
      const earnedMinor = await assignmentEarnedMinor(id);
      if (earnedMinor < 0 || earnedMinor > assignment.agreedMinor) throw new Error("FROZEN_EARNED_OUT_OF_RANGE");
      const result = await execute(
        `UPDATE project_assignments SET lifecycle_status='CANCELLED', cancelled_at=datetime('now'),
           cancellation_reason=$1, earned_minor_at_cancellation=$2
         WHERE id=$3 AND lifecycle_status<>'CANCELLED'`,
        [trimmed, earnedMinor, id],
      );
      if (result.rowsAffected !== 1) throw new Error("ASSIGNMENT_ALREADY_CANCELLED");
    },
  );
}

/** Fee released to this assignment by client certificates paid so far. */
async function assignmentEarnedMinor(id: number): Promise<number> {
  const assignment = await selectOne<{ projectId: number; agreedMinor: number }>(
    "SELECT project_id AS projectId, agreed_minor AS agreedMinor FROM project_assignments WHERE id=$1",
    [id],
  );
  if (!assignment) throw new Error("ASSIGNMENT_NOT_FOUND");
  const paid = await selectOne<{ paid: number }>(
    "SELECT COALESCE(SUM(amount_minor),0) AS paid FROM person_payments WHERE assignment_id=$1 AND voided_at IS NULL",
    [id],
  );
  const { loadWorkspaceFinancials } = await import("./financials");
  const workspace = await loadWorkspaceFinancials();
  const states = [...workspace.contractStates.values()].filter(
    (state) => state.contract.projectId === assignment.projectId,
  );
  const { computeTeamPayout } = await import("@mep/core");
  return computeTeamPayout(assignment.agreedMinor, states, paid?.paid ?? 0).releasedMinor;
}

export async function deleteAssignment(id: number): Promise<void> {
  const result = await execute("UPDATE project_assignments SET archived_at=datetime('now'), archive_reason='Archived by user' WHERE id=$1 AND archived_at IS NULL", [id]);
  if (result.rowsAffected !== 1) throw new Error("ASSIGNMENT_NOT_FOUND_OR_ARCHIVED");
}

export function applySyncedAssignment(input: SyncedAssignmentInput): Promise<void> {
  return atomicCommand<void>("apply_synced_assignment_atomic", { input }, () => applySyncedAssignmentDouble(input));
}

function validateSyncedAssignmentInput(input: SyncedAssignmentInput): void {
  if (!input.syncUuid.trim() || !input.updatedAt.trim()) throw new Error("SYNC_ASSIGNMENT_IDENTITY_REQUIRED");
  if (!Number.isSafeInteger(input.agreedMinor) || input.agreedMinor < 0 || !input.currency.trim() || input.fxRateMicro <= 0) {
    throw new Error("INVALID_ASSIGNMENT_INPUT");
  }
  if (input.lifecycleStatus === "ACTIVE") {
    if (input.completedAt || input.cancelledAt || input.cancellationReason || input.earnedMinorAtCancellation !== null) {
      throw new Error("ACTIVE_ASSIGNMENT_HAS_LIFECYCLE_EVIDENCE");
    }
  } else if (input.lifecycleStatus === "COMPLETED") {
    if (!input.completedAt) throw new Error("COMPLETED_ASSIGNMENT_REQUIRES_DATE");
    if (input.cancelledAt || input.cancellationReason || input.earnedMinorAtCancellation !== null) {
      throw new Error("COMPLETED_ASSIGNMENT_HAS_CANCELLATION_EVIDENCE");
    }
  } else if (input.lifecycleStatus === "CANCELLED") {
    if (!input.cancelledAt || !input.cancellationReason?.trim() || input.earnedMinorAtCancellation === null) {
      throw new Error("CANCELLED_ASSIGNMENT_REQUIRES_EVIDENCE");
    }
  } else {
    throw new Error("INVALID_ASSIGNMENT_LIFECYCLE");
  }
}

async function assignmentEarnedMinorAsOf(projectId: number, agreedMinor: number, cutoffDate: string): Promise<number> {
  const { loadWorkspaceFinancials } = await import("./financials");
  const { allocate } = await import("@mep/core");
  const workspace = await loadWorkspaceFinancials();
  const states = [...workspace.contractStates.values()].filter((state) => state.contract.projectId === projectId);
  const stages: Array<{ weight: number; paid: boolean }> = [];
  const paidForCertificate = async (certificateId: number) => {
    const row = await selectOne<{ paid: number }>(
      `SELECT COALESCE(SUM(a.amount_minor),0) AS paid
         FROM payment_certificate_allocations a
         JOIN payments p ON p.id=a.payment_id
        WHERE a.certificate_id=$1 AND p.kind='CERTIFICATE'
          AND p.deleted_at IS NULL AND p.voided_at IS NULL AND p.date <= $2`,
      [certificateId, cutoffDate],
    );
    return row?.paid ?? 0;
  };
  for (const state of states) {
    const milestones = state.contract.milestones ? JSON.parse(state.contract.milestones) as Array<{ percentBp?: number; certificateId?: number | null }> : [];
    if (milestones.length > 0) {
      const amounts = allocate(state.contract.valueMinor, milestones.map((m) => m.percentBp ?? 0));
      for (const [index, m] of milestones.entries()) {
        const payable = state.certificates.find((item) => item.certificate.id === m.certificateId);
        const paid = payable ? await paidForCertificate(payable.certificate.id) : 0;
        const net = payable?.breakdown.netPayableMinor ?? 0;
        stages.push({ weight: amounts[index] ?? 0, paid: payable !== undefined && paid >= Math.max(0, net) });
      }
      continue;
    }
    let scheduled = 0;
    for (const item of state.certificates) {
      const weight = Math.max(0, item.certificate.grossMinor - item.certificate.discountMinor);
      scheduled += weight;
      const paid = await paidForCertificate(item.certificate.id);
      stages.push({
        weight: Math.max(0, item.certificate.grossMinor - item.certificate.discountMinor),
        paid: paid >= Math.max(0, item.breakdown.netPayableMinor),
      });
    }
    if (state.contract.valueMinor > scheduled) {
      stages.push({ weight: state.contract.valueMinor - scheduled, paid: false });
    }
  }
  const amounts = allocate(agreedMinor, stages.map((stage) => stage.weight));
  return stages.reduce((sum, stage, index) => sum + (stage.paid ? amounts[index] ?? 0 : 0), 0);
}

async function applySyncedAssignmentDouble(input: SyncedAssignmentInput): Promise<void> {
  validateSyncedAssignmentInput(input);
  const parent = await selectOne<{ projectArchivedAt: string | null }>(
    `SELECT p.archived_at AS projectArchivedAt
       FROM projects p, people pe
      WHERE p.id=$1 AND pe.id=$2`,
    [input.projectId, input.personId],
  );
  if (!parent) throw new Error("ASSIGNMENT_PARENT_NOT_FOUND");
  if (parent.projectArchivedAt !== null && input.archivedAt === null) throw new Error("PROJECT_ARCHIVED");
  const derivedEarned = input.lifecycleStatus === "CANCELLED"
    ? await assignmentEarnedMinorAsOf(input.projectId, input.agreedMinor, input.cancelledAt!.slice(0, 10))
    : null;
  if (input.lifecycleStatus === "CANCELLED" && input.earnedMinorAtCancellation !== derivedEarned) {
    throw new Error("SYNC_CANCELLATION_EARNED_MISMATCH");
  }
  if (input.localId !== null) {
    const stored = await selectOne<{
      personId: number;
      projectId: number;
      lifecycleStatus: AssignmentLifecycle;
      cancelledAt: string | null;
      cancellationReason: string | null;
      earnedMinorAtCancellation: number | null;
    }>(
      `SELECT person_id AS personId,project_id AS projectId,lifecycle_status AS lifecycleStatus,
              cancelled_at AS cancelledAt,cancellation_reason AS cancellationReason,
              earned_minor_at_cancellation AS earnedMinorAtCancellation
         FROM project_assignments WHERE id=$1`,
      [input.localId],
    );
    if (!stored) throw new Error("ASSIGNMENT_NOT_FOUND");
    if (stored.personId !== input.personId || stored.projectId !== input.projectId) throw new Error("ASSIGNMENT_PARENT_IMMUTABLE");
    if (stored.lifecycleStatus === "CANCELLED" && (
      input.lifecycleStatus !== "CANCELLED" ||
      input.cancelledAt !== stored.cancelledAt ||
      input.cancellationReason !== stored.cancellationReason ||
      input.earnedMinorAtCancellation !== stored.earnedMinorAtCancellation
    )) {
      throw new Error("CANCELLATION_EVIDENCE_IS_FINAL");
    }
    await execute(
      `UPDATE project_assignments SET agreed_minor=$1,currency=$2,fx_rate_micro=$3,scope=$4,
         progress_note=$5,archived_at=$6,archived_by=$7,archive_reason=$8,lifecycle_status=$9,
         completed_at=$10,cancelled_at=$11,cancellation_reason=$12,
         earned_minor_at_cancellation=$13,sync_uuid=$14,updated_at=$15
       WHERE id=$16`,
      [input.agreedMinor, input.currency, input.fxRateMicro, input.scope, input.progressNote,
       input.archivedAt, input.archivedBy, input.archiveReason, input.lifecycleStatus,
       input.completedAt, input.cancelledAt, input.cancellationReason?.trim() ?? null,
       derivedEarned, input.syncUuid, input.updatedAt, input.localId],
    );
  } else {
    const r = await execute(
      `INSERT INTO project_assignments
         (person_id,project_id,agreed_minor,currency,fx_rate_micro,scope,progress_note,
          created_at,archived_at,archived_by,archive_reason,lifecycle_status,completed_at,
          cancelled_at,cancellation_reason,earned_minor_at_cancellation,sync_uuid,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [input.personId, input.projectId, input.agreedMinor, input.currency, input.fxRateMicro,
       input.scope, input.progressNote, input.createdAt ?? input.updatedAt, input.archivedAt,
       input.archivedBy, input.archiveReason, input.lifecycleStatus, input.completedAt,
       input.cancelledAt, input.cancellationReason?.trim() ?? null, derivedEarned,
       input.syncUuid, input.updatedAt],
    );
    void r;
  }
}

// --- person payments ---

export interface SyncedPersonPaymentInput {
  localId: number | null;
  syncUuid: string;
  updatedAt: string;
  assignmentId: number;
  date: string;
  amountMinor: number;
  note: string | null;
  createdAt: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  reversalOfId: number | null;
}

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
  return atomicCommand<number>("create_person_payment_atomic", { input }, async () => {
  // guard against accidental double-recording (double-click, repeated "Pay"):
  // an EXACT twin — same assignment, date, amount and note — is rejected;
  // change the date or note to record a genuine second payment
  const twin = await selectOne<{ id: number }>(
    "SELECT id FROM person_payments WHERE assignment_id=$1 AND date=$2 AND amount_minor=$3 AND note IS $4 AND voided_at IS NULL LIMIT 1",
    [input.assignmentId, input.date, input.amountMinor, input.note ?? null],
  );
  if (twin) throw new Error("DUPLICATE_PERSON_PAYMENT");

  const ctx = await selectOne<{
    project_id: number;
    currency: string;
    fx_rate_micro: number;
    person_name: string;
    person_type: string;
    agreed_minor: number;
    lifecycle_status: AssignmentLifecycle;
    earned_minor_at_cancellation: number | null;
    archived_at: string | null;
    project_archived_at: string | null;
    person_archived_at: string | null;
  }>(
    `SELECT a.project_id, a.currency, a.fx_rate_micro, a.agreed_minor, a.lifecycle_status,
            a.earned_minor_at_cancellation, a.archived_at,
            p.archived_at AS project_archived_at,
            pe.name AS person_name, pe.type AS person_type, pe.archived_at AS person_archived_at
     FROM project_assignments a
     JOIN people pe ON pe.id = a.person_id
     JOIN projects p ON p.id = a.project_id
     WHERE a.id = $1`,
    [input.assignmentId],
  );
  if (!ctx) throw new Error("ASSIGNMENT_NOT_FOUND");
  // Same derivation and the same order of checks as the Rust command, so the
  // double cannot accept a payment production would reject.
  if (ctx.archived_at !== null || ctx.project_archived_at !== null || ctx.person_archived_at !== null) {
    throw new Error("ARCHIVED_ASSIGNMENT_CANNOT_BE_PAID");
  }
  const earnedMinor = ctx.lifecycle_status === "CANCELLED"
    ? Math.max(0, ctx.earned_minor_at_cancellation ?? 0)
    : Math.max(0, await assignmentEarnedMinor(input.assignmentId));
  const paidRow = await selectOne<{ paid: number }>(
    "SELECT COALESCE(SUM(amount_minor),0) AS paid FROM person_payments WHERE assignment_id=$1 AND voided_at IS NULL",
    [input.assignmentId],
  );
  const dueMinor = Math.max(0, earnedMinor - (paidRow?.paid ?? 0));
  if (input.amountMinor > dueMinor) throw new Error("PERSON_PAYMENT_EXCEEDS_DUE");

  const r = await execute(
    "INSERT INTO person_payments (assignment_id, date, amount_minor, note) VALUES ($1,$2,$3,$4)",
    [input.assignmentId, input.date, input.amountMinor, input.note ?? null],
  );
  const paymentId = r.lastInsertId ?? 0;
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
    return paymentId;
  });
}

export function applySyncedPersonPayment(input: SyncedPersonPaymentInput): Promise<number> {
  return atomicCommand<number>("apply_synced_person_payment_atomic", { input }, () => applySyncedPersonPaymentDouble(input));
}

async function personPaymentContext(assignmentId: number) {
  const ctx = await selectOne<{
    projectId: number;
    currency: string;
    fxRateMicro: number;
    personName: string;
    personType: string;
    agreedMinor: number;
    lifecycleStatus: AssignmentLifecycle;
    earnedMinorAtCancellation: number | null;
    archivedAt: string | null;
    projectArchivedAt: string | null;
    personArchivedAt: string | null;
  }>(
    `SELECT a.project_id AS projectId, a.currency, a.fx_rate_micro AS fxRateMicro,
            a.agreed_minor AS agreedMinor, a.lifecycle_status AS lifecycleStatus,
            a.earned_minor_at_cancellation AS earnedMinorAtCancellation, a.archived_at AS archivedAt,
            p.archived_at AS projectArchivedAt,
            pe.name AS personName, pe.type AS personType, pe.archived_at AS personArchivedAt
     FROM project_assignments a
     JOIN people pe ON pe.id = a.person_id
     JOIN projects p ON p.id = a.project_id
     WHERE a.id = $1`,
    [assignmentId],
  );
  if (!ctx) throw new Error("ASSIGNMENT_NOT_FOUND");
  if (ctx.archivedAt !== null || ctx.projectArchivedAt !== null || ctx.personArchivedAt !== null) {
    throw new Error("ARCHIVED_ASSIGNMENT_CANNOT_BE_PAID");
  }
  return ctx;
}

async function personPaymentDue(assignmentId: number, excludePaymentId?: number): Promise<Awaited<ReturnType<typeof personPaymentContext>> & { dueMinor: number }> {
  const ctx = await personPaymentContext(assignmentId);
  const earnedMinor = ctx.lifecycleStatus === "CANCELLED"
    ? Math.max(0, ctx.earnedMinorAtCancellation ?? 0)
    : Math.max(0, await assignmentEarnedMinor(assignmentId));
  const paid = await selectOne<{ paid: number }>(
    "SELECT COALESCE(SUM(amount_minor),0) AS paid FROM person_payments WHERE assignment_id=$1 AND voided_at IS NULL AND ($2 IS NULL OR id<>$2)",
    [assignmentId, excludePaymentId ?? null],
  );
  return { ...ctx, dueMinor: Math.max(0, earnedMinor - (paid?.paid ?? 0)) };
}

async function applySyncedPersonPaymentDouble(input: SyncedPersonPaymentInput): Promise<number> {
  if (input.amountMinor <= 0 || !input.date.trim()) throw new Error("invalid person payment");
  if (!input.syncUuid.trim() || !input.updatedAt.trim()) throw new Error("SYNC_PERSON_PAYMENT_IDENTITY_REQUIRED");
  const isVoid = input.voidedAt !== null;
  if (input.localId !== null) {
    const stored = await selectOne<{
      assignmentId: number;
      date: string;
      amountMinor: number;
      note: string | null;
      voidedAt: string | null;
      reversalOfId: number | null;
    }>(
      `SELECT assignment_id AS assignmentId,date,amount_minor AS amountMinor,note,
              voided_at AS voidedAt,reversal_of_id AS reversalOfId
         FROM person_payments WHERE id=$1`,
      [input.localId],
    );
    if (!stored) throw new Error("PERSON_PAYMENT_NOT_FOUND");
    if (stored.voidedAt !== null && !isVoid) throw new Error("VOIDED_PERSON_PAYMENT_CANNOT_BE_RESTORED_BY_SYNC");
    if (stored.assignmentId !== input.assignmentId || stored.date !== input.date || stored.amountMinor !== input.amountMinor ||
      stored.note !== input.note || stored.reversalOfId !== input.reversalOfId) {
      throw new Error("PERSON_PAYMENT_IMMUTABLE_BY_SYNC");
    }
    if (isVoid) {
      await execute(
        "UPDATE person_payments SET voided_at=$1,voided_by=$2,void_reason=$3,sync_uuid=$4,updated_at=$5 WHERE id=$6 AND voided_at IS NULL",
        [input.voidedAt, input.voidedBy, input.voidReason?.trim() || "Remote person payment voided", input.syncUuid, input.updatedAt, input.localId],
      );
      await execute(
        "UPDATE expenses SET voided_at=$1,void_reason='Reversed with person payment',updated_at=$2 WHERE person_payment_id=$3 AND voided_at IS NULL",
        [input.voidedAt, input.updatedAt, input.localId],
      );
    } else {
      await execute("UPDATE person_payments SET sync_uuid=$1,updated_at=$2 WHERE id=$3", [input.syncUuid, input.updatedAt, input.localId]);
    }
    return input.localId;
  }
  if (!isVoid) {
    const twin = await selectOne<{ id: number }>(
      "SELECT id FROM person_payments WHERE assignment_id=$1 AND date=$2 AND amount_minor=$3 AND note IS $4 AND voided_at IS NULL LIMIT 1",
      [input.assignmentId, input.date, input.amountMinor, input.note],
    );
    if (twin) throw new Error("DUPLICATE_PERSON_PAYMENT");
    const ctx = await personPaymentDue(input.assignmentId);
    if (input.amountMinor > ctx.dueMinor) throw new Error("PERSON_PAYMENT_EXCEEDS_DUE");
    const category = await selectOne<{ id: number }>(
      "SELECT id FROM expense_categories ORDER BY CASE WHEN name_en=$1 THEN 0 ELSE 1 END, sort_order, id LIMIT 1",
      [ctx.personType === "EMPLOYEE" ? "Salaries" : "Freelancers"],
    );
    if (!category) throw new Error("EXPENSE_CATEGORY_NOT_FOUND");
    const r = await execute(
      `INSERT INTO person_payments (assignment_id,date,amount_minor,note,created_at,reversal_of_id,sync_uuid,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.assignmentId, input.date, input.amountMinor, input.note, input.createdAt ?? input.updatedAt,
       input.reversalOfId, input.syncUuid, input.updatedAt],
    );
    const paymentId = r.lastInsertId ?? 0;
    await execute(
      `INSERT INTO expenses (date,category_id,description,project_id,supplier,amount_minor,currency,fx_rate_micro,person_payment_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.date, category.id, input.note ? `${ctx.personName} — ${input.note}` : ctx.personName,
       ctx.projectId, ctx.personName, input.amountMinor, ctx.currency, ctx.fxRateMicro, paymentId,
       input.createdAt ?? input.updatedAt],
    );
    return paymentId;
  }
  const assignment = await selectOne<{ id: number }>("SELECT id FROM project_assignments WHERE id=$1", [input.assignmentId]);
  if (!assignment) throw new Error("ASSIGNMENT_NOT_FOUND");
  const r = await execute(
    `INSERT INTO person_payments
       (assignment_id,date,amount_minor,note,created_at,voided_at,voided_by,void_reason,reversal_of_id,sync_uuid,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.assignmentId, input.date, input.amountMinor, input.note, input.createdAt ?? input.updatedAt,
     input.voidedAt, input.voidedBy, input.voidReason, input.reversalOfId, input.syncUuid, input.updatedAt],
  );
  return r.lastInsertId ?? 0;
}

/** Reverse a team payment without destroying either financial record. */
export async function deletePersonPayment(id: number): Promise<void> {
  await atomicCommand<void>("delete_person_payment_atomic", { paymentId: id }, async () => {
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
  });
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
    remove: useMutation({
      mutationFn: (v: { id: number; reason?: string }) => deletePerson(v.id, v.reason),
      onSuccess: invalidate,
    }),
    createAssignment: useMutation({ mutationFn: createAssignment, onSuccess: invalidate }),
    updateAssignment: useMutation({
      mutationFn: (v: { id: number; input: AssignmentInput }) => updateAssignment(v.id, v.input),
      onSuccess: invalidate,
    }),
    removeAssignment: useMutation({ mutationFn: deleteAssignment, onSuccess: invalidate }),
    completeAssignment: useMutation({ mutationFn: completeAssignment, onSuccess: invalidate }),
    cancelAssignment: useMutation({
      mutationFn: (v: { id: number; reason: string }) => cancelAssignment(v.id, v.reason),
      onSuccess: invalidate,
    }),
    createPersonPayment: useMutation({ mutationFn: createPersonPayment, onSuccess: invalidate }),
    removePersonPayment: useMutation({ mutationFn: deletePersonPayment, onSuccess: invalidate }),
  };
}
