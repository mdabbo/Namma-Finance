import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  computeCertificate,
  desiredCertificateStatus,
  type AdvanceRecoveryMethod,
  type CertificateStatus,
  type Payment,
  type PaymentAllocation,
  type PaymentInput,
} from "@mep/core";
import { atomicCommand } from "../lib/atomic";
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
  WHERE ct.archived_at IS NULL AND p.archived_at IS NULL`;

export async function listPayments(includeVoided = false): Promise<PaymentListItem[]> {
  const rows = await select<PaymentRow>(`${LIST_SQL} ${includeVoided ? "" : "AND pm.deleted_at IS NULL AND pm.voided_at IS NULL"} ORDER BY pm.date DESC, pm.id DESC`);
  return rows.map(mapPayment);
}

export async function listPaymentsByContract(contractId: number): Promise<PaymentListItem[]> {
  const rows = await select<PaymentRow>(`${LIST_SQL} AND pm.contract_id=$1 AND pm.deleted_at IS NULL AND pm.voided_at IS NULL ORDER BY pm.date, pm.id`, [contractId]);
  return rows.map(mapPayment);
}

export async function listPaymentsByProject(projectId: number): Promise<PaymentListItem[]> {
  const rows = await select<PaymentRow>(
    `${LIST_SQL} AND p.id=$1 AND pm.deleted_at IS NULL AND pm.voided_at IS NULL
     ORDER BY pm.date DESC, pm.id DESC`,
    [projectId],
  );
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

interface CertificatePayableRow {
  id: number;
  status: CertificateStatus;
  grossMinor: number;
  discountMinor: number;
  manualAdvanceRecoveryMinor: number | null;
  contractValueMinor: number;
  vatBp: number;
  retentionBp: number;
  withholdingBp: number;
  advanceMinor: number;
  advanceMethod: AdvanceRecoveryMethod;
}

/**
 * Every live certificate of a contract with its net payable, in the order the
 * advance is recovered. Mirrors `load_contract_payables` in the Rust command
 * layer; advance recovery is cumulative across billable certificates, so the
 * whole contract is walked rather than one certificate in isolation.
 */
export async function loadContractPayables(contractId: number): Promise<{ id: number; status: CertificateStatus; netPayableMinor: number; certifiedBaseMinor: number }[]> {
  const rows = await select<CertificatePayableRow>(
    `SELECT pc.id, pc.status, pc.gross_minor AS grossMinor, pc.discount_minor AS discountMinor,
            pc.manual_advance_recovery_minor AS manualAdvanceRecoveryMinor,
            COALESCE(pc.contract_value_minor_snapshot,c.value_minor) AS contractValueMinor,
            COALESCE(pc.vat_bp_snapshot,c.vat_bp) AS vatBp,
            COALESCE(pc.retention_bp_snapshot,c.retention_bp) AS retentionBp,
            COALESCE(pc.withholding_bp_snapshot,c.withholding_bp) AS withholdingBp,
            COALESCE(pc.advance_minor_snapshot,c.advance_minor) AS advanceMinor,
            COALESCE(pc.advance_method_snapshot,c.advance_recovery_method) AS advanceMethod
     FROM payment_certificates pc JOIN contracts c ON c.id=pc.contract_id
                                  JOIN projects p ON p.id=c.project_id
     WHERE pc.contract_id=$1 AND pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
       AND c.archived_at IS NULL AND p.archived_at IS NULL
     ORDER BY pc.seq, pc.id`,
    [contractId],
  );
  let recoveredBefore = 0;
  return rows.map((row) => {
    if (row.status === "DRAFT") return { id: row.id, status: row.status, netPayableMinor: 0, certifiedBaseMinor: 0 };
    const breakdown = computeCertificate({
      grossMinor: row.grossMinor,
      discountMinor: row.discountMinor,
      vatBp: row.vatBp,
      retentionBp: row.retentionBp,
      withholdingBp: row.withholdingBp,
      advance: {
        method: row.advanceMethod,
        contractValueMinor: row.contractValueMinor,
        advanceMinor: row.advanceMinor,
        recoveredBeforeMinor: recoveredBefore,
        manualRecoveryMinor: row.manualAdvanceRecoveryMinor,
      },
    });
    recoveredBefore += breakdown.advanceRecoveryMinor;
    return { id: row.id, status: row.status, netPayableMinor: breakdown.netPayableMinor, certifiedBaseMinor: breakdown.baseMinor };
  });
}

/** Allocations that count as collected: only those of still-live payments. */
export async function validAllocatedMinor(certificateId: number): Promise<number> {
  const row = await selectOne<{ allocated: number }>(
    `SELECT COALESCE(SUM(a.amount_minor),0) AS allocated
     FROM payment_certificate_allocations a JOIN payments p ON p.id=a.payment_id
     WHERE a.certificate_id=$1 AND p.kind='CERTIFICATE'
       AND p.deleted_at IS NULL AND p.voided_at IS NULL`,
    [certificateId],
  );
  return row?.allocated ?? 0;
}

/**
 * Recalculate collection status for the given certificates from stored payment
 * evidence. Must be called inside an open transaction.
 *
 * This is the fallback engine used when the Rust command layer is absent (the
 * test harness and the end-to-end browser bridge). Production always goes
 * through `reconcile_certificates` in Rust; both read the same rows and apply
 * the same `desiredCertificateStatus` rule, so the two agree by construction.
 */
export async function reconcileWithinTransaction(certificateIds: number[]): Promise<number> {
  const unique = [...new Set(certificateIds)];
  if (unique.length === 0) return 0;
  const contracts = await select<{ contractId: number }>(
    `SELECT DISTINCT contract_id AS contractId FROM payment_certificates
     WHERE id IN (${unique.map((_, index) => `$${index + 1}`).join(",")})
       AND deleted_at IS NULL AND voided_at IS NULL AND archived_at IS NULL`,
    unique,
  );
  const wanted = new Set(unique);
  let changed = 0;
  for (const { contractId } of contracts) {
    for (const payable of await loadContractPayables(contractId)) {
      if (payable.status === "DRAFT" || !wanted.has(payable.id)) continue;
      const allocated = await validAllocatedMinor(payable.id);
      const desired = desiredCertificateStatus(payable.status, payable.netPayableMinor, allocated, payable.certifiedBaseMinor);
      if (desired === payable.status) continue;
      await execute("UPDATE payment_certificates SET status=$1 WHERE id=$2 AND deleted_at IS NULL", [desired, payable.id]);
      changed += 1;
    }
  }
  return changed;
}

/**
 * Recalculate payment-driven certificate statuses from stored evidence.
 *
 * Callers pass certificate identities only — never a status — so an import or
 * sync pull cannot assert an outcome. An empty list reconciles everything.
 */
export async function reconcileCertificateStatuses(certificateIds?: number[]): Promise<number> {
  if (certificateIds?.length === 0) return 0;
  return atomicCommand<number>(
    "reconcile_certificates_atomic",
    { certificateIds: certificateIds ?? [] },
    async () => {
      const targets = certificateIds ?? (await select<{ id: number }>(
        `SELECT pc.id FROM payment_certificates pc
         JOIN contracts c ON c.id=pc.contract_id
         JOIN projects p ON p.id=c.project_id
         WHERE pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
           AND c.archived_at IS NULL AND p.archived_at IS NULL`,
      )).map((row) => row.id);
      if (targets.length === 0) return 0;
      return reconcileWithinTransaction(targets);
    },
  );
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
  return atomicCommand<number>("create_payment_atomic", { input, allocations }, async () => {
    const r = await execute(
      `INSERT INTO payments (contract_id, kind, number, date, amount_minor, method, bank, reference, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [input.contractId, input.kind, input.number, input.date, input.amountMinor, input.method,
       input.bank ?? null, input.reference ?? null, input.notes ?? null],
    );
    const paymentId = r.lastInsertId ?? 0;
    for (const a of allocations) {
      await execute(
        "INSERT INTO payment_certificate_allocations (payment_id, certificate_id, amount_minor) VALUES ($1,$2,$3)",
        [paymentId, a.certificateId, a.amountMinor],
      );
    }
    await reconcileWithinTransaction(allocations.map((allocation) => allocation.certificateId));
    return paymentId;
  });
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
  // The union of what this payment used to settle and what it settles now, so a
  // certificate dropped from the payment reopens.
  const touched = [
    ...previous.map((item) => item.certificateId),
    ...allocations.map((allocation) => allocation.certificateId),
  ];
  await atomicCommand<void>("update_payment_atomic", { paymentId: id, input, allocations }, async () => {
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
    await reconcileWithinTransaction(touched);
  });
}

/** Void (soft) — history matters for payments. Allocations of voided payments are ignored by calc. */
export function deletePayment(id: number, reason?: string): Promise<void> {
  return withLock(() => deletePaymentUnlocked(id, reason));
}

async function deletePaymentUnlocked(id: number, reason?: string): Promise<void> {
  // Captured before voiding: once the payment is not live its allocations stop
  // counting as evidence, so the certificates it settled must reopen.
  const previous = await listAllocationsByPayment(id);
  const touched = previous.map((item) => item.certificateId);
  const voidReason = reason?.trim() || "Voided by user";
  await atomicCommand<void>("void_payment_atomic", { paymentId: id, reason: voidReason }, async () => {
    // Matches the Rust guard: an already-retired payment is not evidence, so
    // voiding it would rewrite when the money left the books.
    const result = await execute("UPDATE payments SET deleted_at=datetime('now'), voided_at=datetime('now'), void_reason=$2 WHERE id=$1 AND voided_at IS NULL AND deleted_at IS NULL", [id, voidReason]);
    if (result.rowsAffected !== 1) throw new Error("PAYMENT_NOT_FOUND_OR_VOIDED");
    await reconcileWithinTransaction(touched);
  });
}

export function usePayments(includeVoided = false) {
  return useQuery({ queryKey: ["payments", includeVoided], queryFn: () => listPayments(includeVoided) });
}
export function usePaymentsByContract(contractId: number) {
  return useQuery({ queryKey: ["payments", "contract", contractId], queryFn: () => listPaymentsByContract(contractId) });
}
export function usePaymentsByProject(projectId: number) {
  return useQuery({
    queryKey: ["payments", "project", projectId],
    queryFn: () => listPaymentsByProject(projectId),
  });
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
    remove: useMutation({
      mutationFn: (v: { id: number; reason?: string }) => deletePayment(v.id, v.reason),
      onSuccess: invalidate,
    }),
  };
}
