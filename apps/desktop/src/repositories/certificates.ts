import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CertificateInput, CertificateStatus, PaymentCertificate } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";
import { atomicCommand } from "../lib/atomic";

export interface CertificateRow {
  id: number;
  contract_id: number;
  seq: number;
  number: string;
  date: string;
  submission_date: string | null;
  due_date_override: string | null;
  description: string | null;
  gross_minor: number;
  discount_minor: number;
  manual_advance_recovery_minor: number | null;
  contract_revision_id: number | null;
  contract_value_minor_snapshot: number | null;
  vat_bp_snapshot: number | null;
  retention_bp_snapshot: number | null;
  withholding_bp_snapshot: number | null;
  advance_minor_snapshot: number | null;
  advance_method_snapshot: PaymentCertificate["advanceMethodSnapshot"];
  payment_terms_days_snapshot: number | null;
  currency_snapshot: string | null;
  fx_rate_micro_snapshot: number | null;
  status: CertificateStatus;
  deleted_at: string | null;
  created_at: string;
  contract_number?: string;
  project_id?: number;
  project_name?: string;
  project_code?: string;
  currency?: string;
  client_name?: string;
}

export interface CertificateListItem extends PaymentCertificate {
  contractNumber: string;
  projectId: number;
  projectName: string;
  projectCode: string;
  currency: string;
  clientName: string;
}

export function mapCertificate(r: CertificateRow): CertificateListItem {
  return {
    id: r.id,
    contractId: r.contract_id,
    seq: r.seq,
    number: r.number,
    date: r.date,
    submissionDate: r.submission_date,
    dueDateOverride: r.due_date_override,
    description: r.description,
    grossMinor: r.gross_minor,
    discountMinor: r.discount_minor,
    manualAdvanceRecoveryMinor: r.manual_advance_recovery_minor,
    contractRevisionId: r.contract_revision_id,
    contractValueMinorSnapshot: r.contract_value_minor_snapshot,
    vatBpSnapshot: r.vat_bp_snapshot,
    retentionBpSnapshot: r.retention_bp_snapshot,
    withholdingBpSnapshot: r.withholding_bp_snapshot,
    advanceMinorSnapshot: r.advance_minor_snapshot,
    advanceMethodSnapshot: r.advance_method_snapshot,
    paymentTermsDaysSnapshot: r.payment_terms_days_snapshot,
    currencySnapshot: r.currency_snapshot,
    fxRateMicroSnapshot: r.fx_rate_micro_snapshot,
    status: r.status,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
    contractNumber: r.contract_number ?? "",
    projectId: r.project_id ?? 0,
    projectName: r.project_name ?? "",
    projectCode: r.project_code ?? "",
    currency: r.currency ?? "EGP",
    clientName: r.client_name ?? "",
  };
}

const LIST_SQL = `
  SELECT pc.*, ct.number AS contract_number, p.id AS project_id, p.name AS project_name,
         p.code AS project_code, COALESCE(pc.currency_snapshot,p.currency) AS currency, cl.name AS client_name
  FROM payment_certificates pc
  JOIN contracts ct ON ct.id = pc.contract_id
  JOIN projects p ON p.id = ct.project_id
  JOIN clients cl ON cl.id = p.client_id
  WHERE pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
    AND ct.archived_at IS NULL AND p.archived_at IS NULL`;

export async function listCertificates(): Promise<CertificateListItem[]> {
  const rows = await select<CertificateRow>(`${LIST_SQL} ORDER BY pc.date DESC, pc.id DESC`);
  return rows.map(mapCertificate);
}

export async function listCertificatesByContract(contractId: number): Promise<CertificateListItem[]> {
  const rows = await select<CertificateRow>(`${LIST_SQL} AND pc.contract_id = $1 ORDER BY pc.seq, pc.id`, [contractId]);
  return rows.map(mapCertificate);
}

export async function getCertificate(id: number): Promise<CertificateListItem | null> {
  const row = await selectOne<CertificateRow>(`${LIST_SQL} AND pc.id = $1`, [id]);
  return row ? mapCertificate(row) : null;
}

export async function nextCertificateSeq(contractId: number): Promise<number> {
  const row = await selectOne<{ max_seq: number | null }>(
    "SELECT MAX(seq) AS max_seq FROM payment_certificates WHERE contract_id = $1 AND deleted_at IS NULL",
    [contractId],
  );
  return (row?.max_seq ?? 0) + 1;
}

export async function nextCertificateNumber(prefix = "CERT", date = new Date()): Promise<string> {
  const { reserveNextNumber } = await import("./numbering");
  return reserveNextNumber("CERTIFICATE", prefix, date);
}

/** The financial + administrative fields the Rust `CertificateCommandInput` carries (number is passed separately). */
function toCertificateCommandInput(input: CertificateInput) {
  return {
    contractId: input.contractId,
    date: input.date,
    submissionDate: input.submissionDate ?? null,
    dueDateOverride: input.dueDateOverride ?? null,
    dueDateConfirmed: input.dueDateConfirmed ?? false,
    description: input.description ?? null,
    grossMinor: input.grossMinor,
    discountMinor: input.discountMinor,
    manualAdvanceRecoveryMinor: input.manualAdvanceRecoveryMinor ?? null,
    status: input.status,
  };
}

/** Live certificate ids of a contract, for the whole-contract reconcile (test double). */
async function contractCertificateIdsDouble(contractId: number): Promise<number[]> {
  const rows = await select<{ id: number }>(
    `SELECT id FROM payment_certificates
     WHERE contract_id=$1 AND deleted_at IS NULL AND voided_at IS NULL AND archived_at IS NULL
     ORDER BY seq,id`,
    [contractId],
  );
  return rows.map((row) => row.id);
}

/**
 * Reject any write to a certificate whose contract — or whose contract's
 * project — is archived (test double for Rust `assert_contract_writable`).
 *
 * Every certificate read path excludes archived contracts and projects, so a
 * certificate written against one is invisible: never listed, never reconciled,
 * never covered by the allocation check. Archived means read-only, as it
 * already does for payments.
 */
async function assertContractWritableDouble(contractId: number): Promise<void> {
  const row = await selectOne<{ contractArchivedAt: string | null; projectArchivedAt: string | null }>(
    `SELECT c.archived_at AS contractArchivedAt, p.archived_at AS projectArchivedAt
     FROM contracts c JOIN projects p ON p.id=c.project_id WHERE c.id=$1`,
    [contractId],
  );
  if (!row) throw new Error("CONTRACT_NOT_FOUND");
  if (row.contractArchivedAt !== null || row.projectArchivedAt !== null) {
    throw new Error("ARCHIVED_CONTRACT_IS_READ_ONLY");
  }
}

/** Reject over-allocation / allocated drafts across the contract (test double). */
async function assertContractAllocationIntegrityDouble(contractId: number): Promise<void> {
  const { loadContractPayables, validAllocatedMinor } = await import("./payments");
  for (const payable of await loadContractPayables(contractId)) {
    const allocated = await validAllocatedMinor(payable.id);
    if (payable.status === "DRAFT") {
      if (allocated > 0) throw new Error("ALLOCATED_CERTIFICATE_CANNOT_BE_DRAFT");
      continue;
    }
    if (allocated > Math.max(0, payable.netPayableMinor)) throw new Error("ALLOCATION_EXCEEDS_CERTIFICATE_UNPAID");
  }
}

async function reconcileContractDouble(contractId: number): Promise<void> {
  const { reconcileWithinTransaction } = await import("./payments");
  await reconcileWithinTransaction(await contractCertificateIdsDouble(contractId));
}

/**
 * Production certificate mutations are Rust-owned BEGIN IMMEDIATE transactions
 * (create/update/transition/void). The functions below dispatch to them and
 * carry a behaviourally-equivalent TypeScript double for the vitest harness and
 * the browser bridge — the double runs inside `runInTransaction`, so its
 * mutation, allocation-integrity check and whole-contract reconcile land as one
 * fact exactly as the Rust command does.
 */
/**
 * Create a certificate. The sequence is reserved inside the atomic command, so
 * a legacy `seq` argument is accepted for source compatibility but ignored —
 * the database is the authority on sequence, which is what makes concurrent
 * creation collision-free.
 */
export function createCertificate(seqOrInput: number | CertificateInput, maybeInput?: CertificateInput): Promise<number> {
  const input = typeof seqOrInput === "number" ? (maybeInput as CertificateInput) : seqOrInput;
  return atomicCommand<number>(
    "create_certificate_atomic",
    { number: input.number, input: toCertificateCommandInput(input) },
    () => createCertificateDouble(input.number, input),
  );
}

async function createCertificateDouble(number: string, input: CertificateInput): Promise<number> {
  if (input.status === "PAID") throw new Error("PAID_REQUIRES_PAYMENT");
  if (input.discountMinor < 0 || input.grossMinor < 0 || input.discountMinor > input.grossMinor) throw new Error("INVALID_CERTIFICATE_AMOUNTS");
  if (!number.trim()) throw new Error("CERTIFICATE_NUMBER_REQUIRED");
  await assertContractWritableDouble(input.contractId);
  const seqRow = await selectOne<{ seq: number }>(
    "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM payment_certificates WHERE contract_id=$1 AND deleted_at IS NULL",
    [input.contractId],
  );
  const seq = seqRow?.seq ?? 1;
  const inserted = await execute(
    `INSERT INTO payment_certificates (contract_id, seq, number, date, submission_date, due_date_override,due_date_confirmed_at,
        description, gross_minor, discount_minor, manual_advance_recovery_minor, status,
        contract_revision_id,contract_value_minor_snapshot,vat_bp_snapshot,retention_bp_snapshot,
        withholding_bp_snapshot,advance_minor_snapshot,advance_method_snapshot,payment_terms_days_snapshot,
        currency_snapshot,fx_rate_micro_snapshot)
     SELECT $1,$2,$3,$4,$5,$6,CASE WHEN $7=1 THEN datetime('now') END,$8,$9,$10,$11,$12,
        r.id,r.contract_value_minor,r.vat_bp,r.retention_bp,r.withholding_bp,r.advance_minor,
        r.advance_recovery_method,r.payment_terms_days,r.currency,r.fx_rate_micro
     FROM contract_revisions r WHERE r.contract_id=$1 AND r.approved_at IS NOT NULL
       AND (r.effective_date <= $4 OR r.revision_number=1)
     ORDER BY CASE WHEN r.effective_date <= $4 THEN 0 ELSE 1 END, r.effective_date DESC, r.revision_number DESC LIMIT 1`,
    [input.contractId, seq, number, input.date, input.submissionDate ?? null,
     input.dueDateOverride ?? null, input.dueDateConfirmed ? 1 : 0, input.description ?? null, input.grossMinor, input.discountMinor,
     input.manualAdvanceRecoveryMinor ?? null, input.status],
  );
  if (inserted.rowsAffected !== 1) throw new Error("NO_APPROVED_CONTRACT_REVISION");
  const id = inserted.lastInsertId ?? 0;
  await assertContractAllocationIntegrityDouble(input.contractId);
  await reconcileContractDouble(input.contractId);
  return id;
}

export function updateCertificate(id: number, input: CertificateInput): Promise<void> {
  return atomicCommand<void>(
    "update_certificate_atomic",
    { certificateId: id, number: input.number, input: toCertificateCommandInput(input) },
    () => updateCertificateDouble(id, input.number, input),
  );
}

async function updateCertificateDouble(id: number, number: string, input: CertificateInput): Promise<void> {
  if (input.status === "PAID") throw new Error("PAID_REQUIRES_PAYMENT");
  if (input.discountMinor < 0 || input.grossMinor < 0 || input.discountMinor > input.grossMinor) throw new Error("INVALID_CERTIFICATE_AMOUNTS");
  const stored = await selectOne<{ contractId: number; status: CertificateStatus; number: string; date: string; grossMinor: number; discountMinor: number; manualAdvanceRecoveryMinor: number | null }>(
    `SELECT contract_id AS contractId,status,number,date,gross_minor AS grossMinor,discount_minor AS discountMinor,
            manual_advance_recovery_minor AS manualAdvanceRecoveryMinor
     FROM payment_certificates WHERE id=$1 AND deleted_at IS NULL AND voided_at IS NULL`,
    [id],
  );
  if (!stored) throw new Error("CERTIFICATE_NOT_FOUND");
  // The certificate is located by id, so a caller-supplied contract id that
  // disagrees with the stored one would otherwise bind a foreign contract's
  // approved revision — VAT, retention, withholding, advance, payment terms,
  // currency and historical FX — onto this certificate while leaving it filed
  // under its own contract. The stored contract is the only truth.
  if (input.contractId !== stored.contractId) throw new Error("CERTIFICATE_CONTRACT_MISMATCH");
  await assertContractWritableDouble(stored.contractId);
  if (stored.status === "PAID") throw new Error("PAID_CERTIFICATE_IMMUTABLE");
  if (stored.status === "DRAFT") {
    if (input.status !== "DRAFT" && input.status !== "SUBMITTED") throw new Error("USE_TRANSITION_FOR_APPROVAL");
    const updated = await execute(
      `WITH chosen AS (
         SELECT r.* FROM contract_revisions r
         WHERE r.contract_id=$1 AND r.approved_at IS NOT NULL
           AND (r.effective_date <= $3 OR r.revision_number=1)
         ORDER BY CASE WHEN r.effective_date <= $3 THEN 0 ELSE 1 END, r.effective_date DESC, r.revision_number DESC LIMIT 1
       )
       UPDATE payment_certificates SET number=$2, date=$3, submission_date=$4, due_date_override=$5,
         due_date_confirmed_at=CASE WHEN $6=1 THEN datetime('now') END,
         description=$7, gross_minor=$8, discount_minor=$9, manual_advance_recovery_minor=$10, status=$11,
         contract_revision_id=(SELECT id FROM chosen), contract_value_minor_snapshot=(SELECT contract_value_minor FROM chosen),
         vat_bp_snapshot=(SELECT vat_bp FROM chosen), retention_bp_snapshot=(SELECT retention_bp FROM chosen),
         withholding_bp_snapshot=(SELECT withholding_bp FROM chosen), advance_minor_snapshot=(SELECT advance_minor FROM chosen),
         advance_method_snapshot=(SELECT advance_recovery_method FROM chosen), payment_terms_days_snapshot=(SELECT payment_terms_days FROM chosen),
         currency_snapshot=(SELECT currency FROM chosen), fx_rate_micro_snapshot=(SELECT fx_rate_micro FROM chosen)
       WHERE id=$12 AND status='DRAFT' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM chosen)`,
      [stored.contractId, number, input.date, input.submissionDate ?? null, input.dueDateOverride ?? null,
       input.dueDateConfirmed ? 1 : 0, input.description ?? null, input.grossMinor, input.discountMinor,
       input.manualAdvanceRecoveryMinor ?? null, input.status, id],
    );
    if (updated.rowsAffected !== 1) throw new Error("CERTIFICATE_REVISION_BIND_FAILED");
  } else {
    const financialsChanged =
      stored.grossMinor !== input.grossMinor ||
      stored.discountMinor !== input.discountMinor ||
      (stored.manualAdvanceRecoveryMinor ?? null) !== (input.manualAdvanceRecoveryMinor ?? null) ||
      stored.date !== input.date ||
      stored.number !== number;
    if (financialsChanged) throw new Error("CERTIFICATE_FINANCIALS_IMMUTABLE");
    const updated = await execute(
      `UPDATE payment_certificates SET submission_date=$1, due_date_override=$2,
         due_date_confirmed_at=CASE WHEN $3=1 THEN COALESCE(due_date_confirmed_at,datetime('now')) ELSE due_date_confirmed_at END,
         description=$4
       WHERE id=$5 AND deleted_at IS NULL AND voided_at IS NULL`,
      [input.submissionDate ?? null, input.dueDateOverride ?? null, input.dueDateConfirmed ? 1 : 0, input.description ?? null, id],
    );
    if (updated.rowsAffected !== 1) throw new Error("CERTIFICATE_NOT_FOUND");
  }
  await assertContractAllocationIntegrityDouble(stored.contractId);
  await reconcileContractDouble(stored.contractId);
}

export function transitionCertificate(id: number, targetStatus: CertificateStatus, submissionDate?: string, dueDateConfirmed = false): Promise<void> {
  return atomicCommand<void>(
    "transition_certificate_atomic",
    { certificateId: id, targetStatus, submissionDate: submissionDate ?? null, dueDateConfirmed },
    () => transitionCertificateDouble(id, targetStatus, submissionDate ?? null, dueDateConfirmed),
  );
}

/** Retained name for existing callers; a status transition is never a PAID assignment. */
export function setCertificateStatus(id: number, status: CertificateStatus, submissionDate?: string, dueDateConfirmed = false): Promise<void> {
  return transitionCertificate(id, status, submissionDate, dueDateConfirmed);
}

async function transitionCertificateDouble(id: number, targetStatus: CertificateStatus, submissionDate: string | null, dueDateConfirmed: boolean): Promise<void> {
  if (targetStatus === "PAID") throw new Error("PAID_REQUIRES_PAYMENT");
  if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(targetStatus)) throw new Error("INVALID_CERTIFICATE_STATUS");
  const { validAllocatedMinor } = await import("./payments");
  const stored = await selectOne<{ contractId: number; status: CertificateStatus }>(
    "SELECT contract_id AS contractId,status FROM payment_certificates WHERE id=$1 AND deleted_at IS NULL AND voided_at IS NULL",
    [id],
  );
  if (!stored) throw new Error("CERTIFICATE_NOT_FOUND");
  await assertContractWritableDouble(stored.contractId);
  if (stored.status === "PAID") throw new Error("PAID_NO_MANUAL_DOWNGRADE");
  if (targetStatus === "DRAFT" && (await validAllocatedMinor(id)) > 0) throw new Error("ALLOCATED_CERTIFICATE_CANNOT_BE_DRAFT");
  if (targetStatus === "SUBMITTED" && stored.status === "DRAFT") {
    const updated = await execute(
      `WITH chosen AS (
         SELECT r.* FROM contract_revisions r JOIN payment_certificates pc ON pc.contract_id=r.contract_id
         WHERE pc.id=$1 AND r.approved_at IS NOT NULL AND (r.effective_date <= pc.date OR r.revision_number=1)
         ORDER BY CASE WHEN r.effective_date <= pc.date THEN 0 ELSE 1 END, r.effective_date DESC, r.revision_number DESC LIMIT 1
       )
       UPDATE payment_certificates SET status='SUBMITTED', submission_date=COALESCE(submission_date,$2),
         due_date_confirmed_at=CASE WHEN $3=1 THEN COALESCE(due_date_confirmed_at,datetime('now')) ELSE due_date_confirmed_at END,
         contract_revision_id=(SELECT id FROM chosen), contract_value_minor_snapshot=(SELECT contract_value_minor FROM chosen),
         vat_bp_snapshot=(SELECT vat_bp FROM chosen), retention_bp_snapshot=(SELECT retention_bp FROM chosen),
         withholding_bp_snapshot=(SELECT withholding_bp FROM chosen), advance_minor_snapshot=(SELECT advance_minor FROM chosen),
         advance_method_snapshot=(SELECT advance_recovery_method FROM chosen), payment_terms_days_snapshot=(SELECT payment_terms_days FROM chosen),
         currency_snapshot=(SELECT currency FROM chosen), fx_rate_micro_snapshot=(SELECT fx_rate_micro FROM chosen)
       WHERE id=$4 AND status='DRAFT' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM chosen)`,
      [id, submissionDate, dueDateConfirmed ? 1 : 0, id],
    );
    if (updated.rowsAffected !== 1) throw new Error("CERTIFICATE_REVISION_BIND_FAILED");
  } else {
    const updated = await execute(
      `UPDATE payment_certificates SET status=$1, submission_date=COALESCE(submission_date,$2),
         due_date_confirmed_at=CASE WHEN $3=1 THEN COALESCE(due_date_confirmed_at,datetime('now')) ELSE due_date_confirmed_at END
       WHERE id=$4 AND deleted_at IS NULL AND voided_at IS NULL`,
      [targetStatus, submissionDate, dueDateConfirmed ? 1 : 0, id],
    );
    if (updated.rowsAffected !== 1) throw new Error("CERTIFICATE_NOT_FOUND");
  }
  await assertContractAllocationIntegrityDouble(stored.contractId);
  await reconcileContractDouble(stored.contractId);
}

/**
 * Void (soft) — the certificate stops counting toward invoiced and outstanding
 * amounts but its record and audit history are kept. The schema forbids hard
 * deletion of a certificate (BEFORE DELETE raises PROTECTED_FINANCIAL_RECORD_USE_VOID),
 * so voiding is the only removal path. A reason is required and a certificate
 * carrying live allocations cannot be voided (void the payment first).
 */
export function voidCertificate(id: number, reason?: string): Promise<void> {
  return atomicCommand<void>(
    "void_certificate_atomic",
    { certificateId: id, reason: reason ?? null },
    () => voidCertificateDouble(id, reason ?? null),
  );
}

/** Retained name for existing callers; supplies a default reason when none is given. */
export function deleteCertificate(id: number, reason?: string): Promise<void> {
  return voidCertificate(id, reason?.trim() || "Voided by user");
}

async function voidCertificateDouble(id: number, reason: string | null): Promise<void> {
  const voidReason = (reason ?? "").trim();
  if (!voidReason) throw new Error("VOID_REASON_REQUIRED");
  const { validAllocatedMinor } = await import("./payments");
  const stored = await selectOne<{ contractId: number }>(
    "SELECT contract_id AS contractId FROM payment_certificates WHERE id=$1 AND deleted_at IS NULL AND voided_at IS NULL",
    [id],
  );
  if (!stored) throw new Error("CERTIFICATE_NOT_FOUND");
  await assertContractWritableDouble(stored.contractId);
  if ((await validAllocatedMinor(id)) > 0) throw new Error("ALLOCATED_CERTIFICATE_CANNOT_BE_VOIDED");
  const updated = await execute(
    "UPDATE payment_certificates SET deleted_at=datetime('now'), voided_at=datetime('now'), void_reason=$2 WHERE id=$1 AND voided_at IS NULL",
    [id, voidReason],
  );
  if (updated.rowsAffected !== 1) throw new Error("CERTIFICATE_NOT_FOUND_OR_VOIDED");
  await assertContractAllocationIntegrityDouble(stored.contractId);
  await reconcileContractDouble(stored.contractId);
}

export function useCertificates() {
  return useQuery({ queryKey: ["certificates"], queryFn: listCertificates });
}
export function useCertificatesByContract(contractId: number) {
  return useQuery({
    queryKey: ["certificates", "contract", contractId],
    queryFn: () => listCertificatesByContract(contractId),
  });
}
export function useCertificate(id: number) {
  return useQuery({ queryKey: ["certificates", id], queryFn: () => getCertificate(id) });
}

export function useCertificateMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["certificates"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
    void qc.invalidateQueries({ queryKey: ["payments"] });
  };
  return {
    create: useMutation({
      mutationFn: (input: CertificateInput) => createCertificate(input),
      onSettled: invalidate,
    }),
    update: useMutation({
      mutationFn: async (v: { id: number; input: CertificateInput }) => {
        await updateCertificate(v.id, v.input);
      },
      onSettled: invalidate,
    }),
    setStatus: useMutation({
      mutationFn: async (v: { id: number; status: CertificateStatus; submissionDate?: string; dueDateConfirmed?: boolean }) => {
        await setCertificateStatus(v.id, v.status, v.submissionDate, v.dueDateConfirmed);
      },
      onSettled: invalidate,
    }),
    remove: useMutation({
      mutationFn: (v: { id: number; reason?: string }) => deleteCertificate(v.id, v.reason),
      onSettled: invalidate,
    }),
  };
}
