import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { execute, select, selectOne } from "../lib/db";
import { getSyncClient } from "../lib/sync/client";
import { sha256Hex } from "./documents";
import { atomicCommand } from "../lib/atomic";
import { reserveNextNumberWithinExistingLock } from "./numbering";

/**
 * Expense claims filed on the phone (plan step F6). Claims arrive only through
 * sync; the desktop's one job is to decide them:
 *
 *  - ACCEPT: reserves the expense number, creates the expense from the claim's
 *    own figures (the office chooses the category, project and, for a foreign
 *    currency, the rate) and records the decision -- one transaction, in Rust
 *    (accept_expense_claim_atomic).
 *  - REJECT: records the decision with a reason (reject_expense_claim_atomic).
 *
 * A decided claim is evidence and cannot change (migration 0010).
 */

export type ClaimDecision = "ACCEPTED" | "REJECTED";

export interface ExpenseClaim {
  id: number;
  personId: number;
  personName: string;
  projectId: number | null;
  projectCode: string | null;
  projectName: string | null;
  categoryId: number | null;
  date: string;
  amountMinor: number;
  currency: string;
  description: string;
  supplier: string | null;
  receiptStorageKey: string | null;
  receiptSha256: string | null;
  submittedAt: string;
  decision: ClaimDecision | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  syncUuid: string;
  /** The expense an accepted claim became (it carries the claim's uuid). */
  expenseId: number | null;
  expenseNumber: string | null;
}

interface ClaimRow {
  id: number;
  person_id: number;
  person_name: string | null;
  project_id: number | null;
  project_code: string | null;
  project_name: string | null;
  category_id: number | null;
  date: string;
  amount_minor: number;
  currency: string;
  description: string;
  supplier: string | null;
  receipt_storage_key: string | null;
  receipt_sha256: string | null;
  submitted_at: string;
  decision: ClaimDecision | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  sync_uuid: string;
  expense_id: number | null;
  expense_number: string | null;
}

const CLAIM_SELECT = `
  SELECT c.*, pe.name AS person_name, p.code AS project_code, p.name AS project_name,
         e.id AS expense_id, e.number AS expense_number
  FROM expense_claims c
  JOIN people pe ON pe.id = c.person_id
  LEFT JOIN projects p ON p.id = c.project_id
  LEFT JOIN expenses e ON e.sync_uuid = c.sync_uuid`;

function toClaim(r: ClaimRow): ExpenseClaim {
  return {
    id: r.id,
    personId: r.person_id,
    personName: r.person_name ?? "",
    projectId: r.project_id,
    projectCode: r.project_code,
    projectName: r.project_name,
    categoryId: r.category_id,
    date: r.date,
    amountMinor: r.amount_minor,
    currency: r.currency,
    description: r.description,
    supplier: r.supplier,
    receiptStorageKey: r.receipt_storage_key,
    receiptSha256: r.receipt_sha256,
    submittedAt: r.submitted_at,
    decision: r.decision,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
    syncUuid: r.sync_uuid,
    expenseId: r.decision === "ACCEPTED" ? r.expense_id : null,
    expenseNumber: r.decision === "ACCEPTED" ? r.expense_number : null,
  };
}

/** Pending claims first (oldest first: first in, first decided), then decided ones, newest first. */
export async function listExpenseClaims(): Promise<ExpenseClaim[]> {
  const rows = await select<ClaimRow>(
    `${CLAIM_SELECT}
     ORDER BY CASE WHEN c.decision IS NULL THEN 0 ELSE 1 END,
              CASE WHEN c.decision IS NULL THEN c.submitted_at END ASC,
              c.decided_at DESC, c.id DESC`,
  );
  return rows.map(toClaim);
}

export async function pendingClaimCount(): Promise<number> {
  const row = await selectOne<{ n: number }>("SELECT COUNT(*) AS n FROM expense_claims WHERE decision IS NULL");
  return row?.n ?? 0;
}

export interface AcceptClaimInput {
  claimId: number;
  categoryId: number;
  projectId: number | null;
  /** EGP per major unit × 1,000,000; 1,000,000 for EGP. */
  fxRateMicro: number;
}

export interface RejectClaimInput {
  claimId: number;
  reason: string;
}

/** Returns the new expense's id. */
export function acceptExpenseClaim(input: AcceptClaimInput): Promise<number> {
  return atomicCommand<number>("accept_expense_claim_atomic", { input }, () => acceptDouble(input));
}

export function rejectExpenseClaim(input: RejectClaimInput): Promise<void> {
  return atomicCommand<void>("reject_expense_claim_atomic", { input }, () => rejectDouble(input));
}

/** The bucket the phone uploads receipts to (docs/supabase-0025-expense-claims.sql). */
const RECEIPT_BUCKET = "namaa-documents";

/**
 * Downloads a claim's receipt photo and checks it against the fingerprint the
 * claim was filed with, so a file replaced after filing is refused rather than
 * shown as evidence. Returns the image bytes; the caller shows them.
 */
export async function downloadClaimReceipt(claim: Pick<ExpenseClaim, "receiptStorageKey" | "receiptSha256">): Promise<Blob> {
  if (!claim.receiptStorageKey || !claim.receiptSha256) throw new Error("CLAIM_HAS_NO_RECEIPT");
  const client = await getSyncClient();
  const { data, error } = await client.storage.from(RECEIPT_BUCKET).download(claim.receiptStorageKey);
  if (error || !data) throw new Error(error?.message ?? "CLAIM_RECEIPT_UNAVAILABLE");
  const bytes = new Uint8Array(await data.arrayBuffer());
  if ((await sha256Hex(bytes)) !== claim.receiptSha256) throw new Error("CLAIM_RECEIPT_CHANGED");
  return new Blob([bytes], { type: "image/jpeg" });
}

export function useExpenseClaims() {
  return useQuery({ queryKey: ["expense-claims"], queryFn: listExpenseClaims });
}

export function usePendingClaimCount() {
  return useQuery({ queryKey: ["expense-claims", "pending"], queryFn: pendingClaimCount });
}

export function useExpenseClaimMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["expense-claims"] });
    void qc.invalidateQueries({ queryKey: ["expenses"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
  };
  return {
    accept: useMutation({ mutationFn: acceptExpenseClaim, onSuccess: invalidate }),
    reject: useMutation({ mutationFn: rejectExpenseClaim, onSuccess: invalidate }),
  };
}

// ─── test doubles: the same rules as lib.rs, for the vitest harness ──────────

const DECIDED_BY = "COALESCE(NULLIF((SELECT value FROM settings WHERE key='sync_email'),''),'DESKTOP')";

async function pendingClaim(claimId: number) {
  const claim = await selectOne<{ sync_uuid: string; date: string; amount_minor: number; currency: string; description: string; supplier: string | null; decision: string | null }>(
    "SELECT sync_uuid, date, amount_minor, currency, description, supplier, decision FROM expense_claims WHERE id=$1",
    [claimId],
  );
  if (!claim) throw new Error("CLAIM_NOT_FOUND");
  if (claim.decision !== null) throw new Error("CLAIM_ALREADY_DECIDED");
  return claim;
}

async function acceptDouble(input: AcceptClaimInput): Promise<number> {
  if (input.fxRateMicro <= 0) throw new Error("CLAIM_FX_RATE_REQUIRED");
  const claim = await pendingClaim(input.claimId);
  if (claim.currency === "EGP" && input.fxRateMicro !== 1_000_000) throw new Error("CLAIM_EGP_RATE_MUST_BE_ONE");
  if (!(await selectOne("SELECT id FROM expense_categories WHERE id=$1", [input.categoryId]))) throw new Error("CLAIM_CATEGORY_NOT_FOUND");
  if (input.projectId !== null) {
    const project = await selectOne<{ archived_at: string | null }>("SELECT archived_at FROM projects WHERE id=$1", [input.projectId]);
    if (!project) throw new Error("CLAIM_PROJECT_NOT_FOUND");
    if (project.archived_at) throw new Error("CLAIM_PROJECT_ARCHIVED");
  }
  if (await selectOne("SELECT id FROM expenses WHERE sync_uuid=$1", [claim.sync_uuid])) throw new Error("CLAIM_EXPENSE_EXISTS");
  const year = Number(claim.date.slice(0, 4));
  if (!Number.isInteger(year)) throw new Error("CLAIM_INVALID_DATE");
  const prefix = (await selectOne<{ value: string }>("SELECT value FROM settings WHERE key='expense_number_prefix'"))?.value?.trim() || "EXP";
  const number = await reserveNextNumberWithinExistingLock("EXPENSE", prefix, new Date(Date.UTC(year, 0, 1)));
  const inserted = await execute(
    `INSERT INTO expenses (number,date,category_id,description,project_id,supplier,amount_minor,currency,fx_rate_micro,sync_uuid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [number, claim.date, input.categoryId, claim.description, input.projectId, claim.supplier, claim.amount_minor, claim.currency, input.fxRateMicro, claim.sync_uuid],
  );
  const decided = await execute(
    `UPDATE expense_claims SET category_id=$1, project_id=$2, decision='ACCEPTED',
       decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by=${DECIDED_BY}
     WHERE id=$3 AND decision IS NULL`,
    [input.categoryId, input.projectId, input.claimId],
  );
  if (decided.rowsAffected !== 1) throw new Error("CLAIM_ALREADY_DECIDED");
  return inserted.lastInsertId ?? 0;
}

async function rejectDouble(input: RejectClaimInput): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("CLAIM_REJECTION_REASON_REQUIRED");
  await pendingClaim(input.claimId);
  const decided = await execute(
    `UPDATE expense_claims SET decision='REJECTED', decision_reason=$1,
       decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by=${DECIDED_BY}
     WHERE id=$2 AND decision IS NULL`,
    [reason, input.claimId],
  );
  if (decided.rowsAffected !== 1) throw new Error("CLAIM_ALREADY_DECIDED");
}
