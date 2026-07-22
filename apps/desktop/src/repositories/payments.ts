import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { desiredCertificateStatus, type Payment, type PaymentAllocation, type PaymentInput } from "@mep/core";
import { invoke } from "@tauri-apps/api/core";
import { execute, select, selectOne } from "../lib/db";
import { withLock } from "../lib/mutex";

export interface PaymentRow {
  id: number;
  contract_id: number;
  kind: Payment["kind"];
  number: string;
  date: string;
  amount_minor: number;
  method: Payment["method"];
  bank: string | null;
  reference: string | null;
  notes: string | null;
  deleted_at: string | null;
  created_at: string;
  contract_number?: string;
  project_id?: number;
  project_name?: string;
  project_code?: string;
  currency?: string;
  client_name?: string;
  allocated_minor?: number;
}

export interface PaymentListItem extends Payment {
  contractNumber: string;
  projectId: number;
  projectName: string;
  projectCode: string;
  currency: string;
  clientName: string;
  allocatedMinor: number;
  unallocatedMinor: number;
}

export function mapPayment(r: PaymentRow): PaymentListItem {
  return {
    id: r.id,
    contractId: r.contract_id,
    kind: r.kind,
    number: r.number,
    date: r.date,
    amountMinor: r.amount_minor,
    method: r.method,
    bank: r.bank,
    reference: r.reference,
    notes: r.notes,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
    contractNumber: r.contract_number ?? "",
    projectId: r.project_id ?? 0,
    projectName: r.project_name ?? "",
    projectCode: r.project_code ?? "",
    currency: r.currency ?? "EGP",
    clientName: r.client_name ?? "",
    allocatedMinor: r.allocated_minor ?? 0,
    unallocatedMinor: r.kind === "CERTIFICATE" ? r.amount_minor - (r.allocated_minor ?? 0) : 0,
  };
}

const LIST_SQL = `
  SELECT pm.*, ct.number AS contract_number, p.id AS project_id, p.name AS project_name,
         p.code AS project_code, p.currency AS currency, cl.name AS client_name,
         COALESCE((SELECT SUM(a.amount_minor) FROM payment_certificate_allocations a WHERE a.payment_id = pm.id), 0) AS allocated_minor
  FROM payments pm
  JOIN contracts ct ON ct.id = pm.contract_id
  JOIN projects p ON p.id = ct.project_id
  JOIN clients cl ON cl.id = p.client_id
  WHERE 1=1`;

export async function listPayments(includeVoided = false): Promise<PaymentListItem[]> {
  const rows = await select<PaymentRow>(`${LIST_SQL} ${includeVoided ? "" : "AND pm.deleted_at IS NULL AND pm.voided_at IS NULL"} ORDER BY pm.date DESC, pm.id DESC`);
  return rows.map(mapPayment);
}

export async function listPaymentsByContract(contractId: number): Promise<PaymentListItem[]> {
  const rows = await select<PaymentRow>(`${LIST_SQL} AND pm.contract_id=$1 AND pm.deleted_at IS NULL AND pm.voided_at IS NULL ORDER BY pm.date, pm.id`, [contractId]);
  return rows.map(mapPayment);
}

export async function getPayment(id: number): Promise<PaymentListItem | null> {
  const row = await selectOne<PaymentRow>(`${LIST_SQL} AND pm.id=$1 AND pm.deleted_at IS NULL AND pm.voided_at IS NULL`, [id]);
  return row ? mapPayment(row) : null;
}

export async function listAllocationsByContract(contractId: number): Promise<PaymentAllocation[]> {
  return select<PaymentAllocation & { paymentId: number; certificateId: number; amountMinor: number }>(
    `SELECT a.id, a.payment_id AS paymentId, a.certificate_id AS certificateId, a.amount_minor AS amountMinor
     FROM payment_certificate_allocations a
     JOIN payments pm ON pm.id = a.payment_id
     WHERE pm.contract_id = $1 AND pm.deleted_at IS NULL AND pm.voided_at IS NULL`,
    [contractId],
  );
}

export async function listAllocationsByPayment(paymentId: number) {
  return select<{ id: number; certificateId: number; certificateNumber: string; amountMinor: number; integrityException: number }>(
    `SELECT a.id, a.certificate_id AS certificateId, pc.number AS certificateNumber, a.amount_minor AS amountMinor,
            a.integrity_exception AS integrityException
     FROM payment_certificate_allocations a
     JOIN payment_certificates pc ON pc.id = a.certificate_id
     WHERE a.payment_id = $1`,
    [paymentId],
  );
}

export interface AllocationInput {
  certificateId: number;
  amountMinor: number;
}

/** Validate a remote allocation before the generic sync engine writes it locally. */
export async function validateSyncedAllocation(
  paymentId: number,
  certificateId: number,
  amountMinor: number,
  existingAllocationId?: number,
): Promise<void> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("INVALID_ALLOCATION_AMOUNT");
  const payment = await selectOne<{ contractId: number; kind: Payment["kind"] }>(
    "SELECT contract_id AS contractId,kind FROM payments WHERE id=$1 AND deleted_at IS NULL AND voided_at IS NULL",
    [paymentId],
  );
  if (!payment || payment.kind !== "CERTIFICATE") throw new Error("ALLOCATION_REQUIRES_ACTIVE_CERTIFICATE_PAYMENT");
  const { loadWorkspaceFinancials } = await import("./financials");
  const state = await loadWorkspaceFinancials().then((workspace) => workspace.contractStates.get(payment.contractId));
  const certificate = state?.certificates.find((item) => item.certificate.id === certificateId);
  if (!certificate) throw new Error("CERTIFICATE_NOT_FOUND_OR_CONTRACT_MISMATCH");
  if (certificate.certificate.status === "DRAFT") throw new Error("ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE");
  const previous = existingAllocationId
    ? await selectOne<{ amountMinor: number }>("SELECT amount_minor AS amountMinor FROM payment_certificate_allocations WHERE id=$1", [existingAllocationId])
    : null;
  if (amountMinor > certificate.unpaidMinor + (previous?.amountMinor ?? 0)) {
    throw new Error("ALLOCATION_EXCEEDS_CERTIFICATE_UNPAID");
  }
}

async function validatePaymentWrite(
  input: PaymentInput,
  allocations: AllocationInput[],
  ownPreviousAllocations: ReadonlyMap<number, number> = new Map(),
): Promise<void> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("INVALID_PAYMENT_AMOUNT");
  const contractDate=await selectOne<{signedDate:string|null}>("SELECT signed_date AS signedDate FROM contracts WHERE id=$1 AND archived_at IS NULL",[input.contractId]);
  if(!contractDate)throw new Error("CONTRACT_NOT_FOUND");
  if(contractDate.signedDate && input.date<contractDate.signedDate)throw new Error("PAYMENT_BEFORE_CONTRACT_DATE");
  if (input.kind !== "CERTIFICATE" && allocations.length > 0) throw new Error("ALLOCATIONS_REQUIRE_CERTIFICATE_PAYMENT");
  const seen = new Set<number>();
  const { loadWorkspaceFinancials } = await import("./financials");
  const workspace = await loadWorkspaceFinancials();
  const contractState = workspace.contractStates.get(input.contractId);
  if (!contractState) throw new Error("CONTRACT_NOT_FOUND");
  const certificateStates = new Map(contractState.certificates.map((state) => [state.certificate.id, state]));
  let total = 0;
  for (const allocation of allocations) {
    if (seen.has(allocation.certificateId)) throw new Error("DUPLICATE_CERTIFICATE_ALLOCATION");
    seen.add(allocation.certificateId);
    if (!Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor <= 0) throw new Error("INVALID_ALLOCATION_AMOUNT");
    total += allocation.amountMinor;
    if (!Number.isSafeInteger(total) || total > input.amountMinor) throw new Error("ALLOCATIONS_EXCEED_PAYMENT");
    const certificate = certificateStates.get(allocation.certificateId);
    if (!certificate) {
      const foreign = await selectOne<{ contractId: number }>(
        "SELECT contract_id AS contractId FROM payment_certificates WHERE id=$1 AND deleted_at IS NULL AND voided_at IS NULL AND archived_at IS NULL",
        [allocation.certificateId],
      );
      if (foreign && foreign.contractId !== input.contractId) throw new Error("ALLOCATION_CONTRACT_MISMATCH");
      throw new Error("CERTIFICATE_NOT_FOUND");
    }
    if (certificate.certificate.status === "DRAFT") throw new Error("ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE");
    const capacity = certificate.unpaidMinor + (ownPreviousAllocations.get(allocation.certificateId) ?? 0);
    if (allocation.amountMinor > capacity) throw new Error("ALLOCATION_EXCEEDS_CERTIFICATE_UNPAID");
  }
}

interface CertificateStatusUpdate {
  certificateId: number;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "PAID";
}

async function deriveStatusUpdates(deltas: Map<number, number>): Promise<CertificateStatusUpdate[]> {
  if (deltas.size === 0) return [];
  const { loadWorkspaceFinancials } = await import("./financials");
  const workspace = await loadWorkspaceFinancials();
  const updates: CertificateStatusUpdate[] = [];
  for (const state of workspace.contractStates.values()) {
    for (const certificate of state.certificates) {
      const delta = deltas.get(certificate.certificate.id);
      if (delta === undefined) continue;
      const status = desiredCertificateStatus(
        certificate.certificate.status,
        certificate.breakdown.netPayableMinor,
        Math.max(0, certificate.paidMinor + delta),
      );
      if (status !== certificate.certificate.status) updates.push({ certificateId: certificate.certificate.id, status });
    }
  }
  return updates;
}

async function applyStatusUpdates(updates: CertificateStatusUpdate[]): Promise<void> {
  for (const update of updates) {
    await execute("UPDATE payment_certificates SET status=$1 WHERE id=$2 AND deleted_at IS NULL", [update.status, update.certificateId]);
  }
}

/** Derive PAID in both directions from live payment allocations only. */
export async function reconcileCertificateStatuses(certificateIds?: number[]): Promise<number> {
  const wanted = certificateIds ? new Set(certificateIds) : null;
  if (wanted?.size === 0) return 0;
  const { loadWorkspaceFinancials } = await import("./financials");
  const ws = await loadWorkspaceFinancials();
  const updates: CertificateStatusUpdate[] = [];
  for (const state of ws.contractStates.values()) {
    for (const cs of state.certificates) {
      if (wanted && !wanted.has(cs.certificate.id)) continue;
      const desired = desiredCertificateStatus(cs.certificate.status, cs.breakdown.netPayableMinor, cs.paidMinor);
      if (desired === cs.certificate.status) continue;
      updates.push({ certificateId: cs.certificate.id, status: desired });
    }
  }
  if (updates.length === 0) return 0;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await invoke("update_certificate_statuses_atomic", { statusUpdates: updates });
  } else {
    await execute("BEGIN IMMEDIATE");
    try {
      await applyStatusUpdates(updates);
      await execute("COMMIT");
    } catch (error) {
      await execute("ROLLBACK");
      throw error;
    }
  }
  return updates.length;
}

/** Create a real payment and its allocations atomically. */
export function createPayment(input: PaymentInput, allocations: AllocationInput[]): Promise<number> {
  return withLock(() => createPaymentUnlocked(input, allocations));
}

export async function nextPaymentNumber(prefix = "PAY", date = new Date()): Promise<string> {
  const { reserveNextNumber } = await import("./numbering");
  return reserveNextNumber("PAYMENT", prefix, date);
}

async function createPaymentUnlocked(input: PaymentInput, allocations: AllocationInput[]): Promise<number> {
  await validatePaymentWrite(input, allocations);
  const deltas = new Map<number, number>();
  for (const allocation of allocations) deltas.set(allocation.certificateId, (deltas.get(allocation.certificateId) ?? 0) + allocation.amountMinor);
  const statusUpdates = await deriveStatusUpdates(deltas);
  let paymentId: number;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    paymentId = await invoke<number>("create_payment_atomic", { input, allocations, statusUpdates });
  } else {
    await execute("BEGIN IMMEDIATE");
    try {
      const r = await execute(
        `INSERT INTO payments (contract_id, kind, number, date, amount_minor, method, bank, reference, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [input.contractId, input.kind, input.number, input.date, input.amountMinor, input.method,
         input.bank ?? null, input.reference ?? null, input.notes ?? null],
      );
      paymentId = r.lastInsertId ?? 0;
      for (const a of allocations) {
        await execute(
          "INSERT INTO payment_certificate_allocations (payment_id, certificate_id, amount_minor) VALUES ($1,$2,$3)",
          [paymentId, a.certificateId, a.amountMinor],
        );
      }
      await applyStatusUpdates(statusUpdates);
      await execute("COMMIT");
    } catch (error) {
      await execute("ROLLBACK");
      throw error;
    }
  }
  return paymentId;
}

export function updatePayment(id: number, input: PaymentInput, allocations: AllocationInput[]): Promise<void> {
  return withLock(() => updatePaymentUnlocked(id, input, allocations));
}

async function updatePaymentUnlocked(id: number, input: PaymentInput, allocations: AllocationInput[]): Promise<void> {
  const existing = await selectOne<{ contractId: number }>(
    "SELECT contract_id AS contractId FROM payments WHERE id=$1 AND deleted_at IS NULL AND voided_at IS NULL",
    [id],
  );
  if (!existing) throw new Error("PAYMENT_NOT_FOUND");
  if (existing.contractId !== input.contractId) throw new Error("PAYMENT_CONTRACT_IMMUTABLE");
  const previous = await listAllocationsByPayment(id);
  if (previous.some((item) => item.integrityException === 1)) {
    throw new Error("LEGACY_DUPLICATE_ALLOCATIONS_REQUIRE_REVIEW");
  }
  await validatePaymentWrite(input, allocations, new Map(previous.map((item) => [item.certificateId, item.amountMinor])));
  const deltas = new Map<number, number>();
  for (const allocation of previous) deltas.set(allocation.certificateId, (deltas.get(allocation.certificateId) ?? 0) - allocation.amountMinor);
  for (const allocation of allocations) deltas.set(allocation.certificateId, (deltas.get(allocation.certificateId) ?? 0) + allocation.amountMinor);
  const statusUpdates = await deriveStatusUpdates(deltas);
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await invoke("update_payment_atomic", { paymentId: id, input, allocations, statusUpdates });
  } else {
    await execute("BEGIN IMMEDIATE");
    try {
      await execute("DELETE FROM payment_certificate_allocations WHERE payment_id = $1", [id]);
      await execute(
        `UPDATE payments SET kind=$1, number=$2, date=$3, amount_minor=$4, method=$5, bank=$6, reference=$7, notes=$8
         WHERE id=$9 AND contract_id=$10 AND deleted_at IS NULL`,
        [input.kind, input.number, input.date, input.amountMinor, input.method,
         input.bank ?? null, input.reference ?? null, input.notes ?? null, id, input.contractId],
      );
      for (const a of allocations) {
        await execute(
          "INSERT INTO payment_certificate_allocations (payment_id, certificate_id, amount_minor) VALUES ($1,$2,$3)",
          [id, a.certificateId, a.amountMinor],
        );
      }
      await applyStatusUpdates(statusUpdates);
      await execute("COMMIT");
    } catch (error) {
      await execute("ROLLBACK");
      throw error;
    }
  }
}

/** Soft delete — history matters for payments. Allocations of deleted payments are ignored by calc. */
export function deletePayment(id: number): Promise<void> {
  return withLock(() => deletePaymentUnlocked(id));
}

async function deletePaymentUnlocked(id: number): Promise<void> {
  const previous = await listAllocationsByPayment(id);
  const deltas = new Map<number, number>();
  for (const allocation of previous) deltas.set(allocation.certificateId, (deltas.get(allocation.certificateId) ?? 0) - allocation.amountMinor);
  const statusUpdates = await deriveStatusUpdates(deltas);
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await invoke("void_payment_atomic", { paymentId: id, statusUpdates });
  } else {
    await execute("BEGIN IMMEDIATE");
    try {
    const result = await execute("UPDATE payments SET deleted_at=datetime('now'), voided_at=datetime('now'), void_reason='Voided by user' WHERE id=$1 AND voided_at IS NULL", [id]);
    if (result.rowsAffected !== 1) throw new Error("PAYMENT_NOT_FOUND_OR_VOIDED");
      await applyStatusUpdates(statusUpdates);
      await execute("COMMIT");
    } catch (error) {
      await execute("ROLLBACK");
      throw error;
    }
  }
}

export function usePayments(includeVoided = false) {
  return useQuery({ queryKey: ["payments", includeVoided], queryFn: () => listPayments(includeVoided) });
}
export function usePaymentsByContract(contractId: number) {
  return useQuery({ queryKey: ["payments", "contract", contractId], queryFn: () => listPaymentsByContract(contractId) });
}
export function usePaymentAllocations(paymentId: number) {
  return useQuery({ queryKey: ["payments", paymentId, "allocations"], queryFn: () => listAllocationsByPayment(paymentId) });
}

export function usePaymentMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["payments"] });
    void qc.invalidateQueries({ queryKey: ["certificates"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
  };
  return {
    create: useMutation({
      mutationFn: (v: { input: PaymentInput; allocations: AllocationInput[] }) =>
        createPayment(v.input, v.allocations),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (v: { id: number; input: PaymentInput; allocations: AllocationInput[] }) =>
        updatePayment(v.id, v.input, v.allocations),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deletePayment, onSuccess: invalidate }),
  };
}
