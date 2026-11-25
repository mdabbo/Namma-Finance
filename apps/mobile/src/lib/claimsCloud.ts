import type { SupabaseClient } from "@supabase/supabase-js";
import { claimStatus, type ClaimStatus } from "./claimForm";
import { sendOutboxRow } from "./timeEntriesCloud";
import type { ExpenseClaimRow, OutboxRow, OutboxTable, QueueItem, SendOutcome } from "./timeQueue";

/**
 * The phone's calls for expense claims (plan step F6): uploading the receipt
 * photo, and reading the claims already filed. The claim row itself is written
 * by the outbox like any other (sendOutboxRow in timeEntriesCloud.ts).
 *
 * This is the ONLY place the phone uploads a file, and the only bucket it
 * uploads to is the one the cloud's storage policy lets each login write in
 * its own folder.
 */

export const RECEIPT_BUCKET = "namaa-documents";

/** What the storage client reports when an upload fails. */
export interface StorageFailure {
  message?: string | null;
  status?: number | string | null;
  statusCode?: number | string | null;
}

/**
 * A dropped connection is retried; a refusal is not. A 5xx, a missing status
 * (the request never got an answer) and 401 (the login is being refreshed) are
 * the first kind; 403 (the cloud's rule said no), 413 (too large) and the other
 * 4xx are the second.
 */
export function classifyStorageError(error: StorageFailure): SendOutcome {
  const message = error.message?.trim() || "unknown error";
  const status = Number(error.statusCode ?? error.status);
  if (!Number.isFinite(status) || status === 0) return { kind: "transient", message };
  if (status >= 500 || status === 401 || status === 408 || status === 429) return { kind: "transient", message };
  if (status === 413) return { kind: "rejected", message: "RECEIPT_TOO_LARGE" };
  return { kind: "rejected", message: "RECEIPT_UPLOAD_REFUSED" };
}

/**
 * Uploads one receipt. The key is the claim's own, so uploading again after a
 * lost answer replaces the same file (upsert) instead of failing or doubling.
 */
export async function uploadReceipt(client: SupabaseClient, key: string, bytes: Uint8Array): Promise<SendOutcome> {
  try {
    const { error } = await client.storage.from(RECEIPT_BUCKET).upload(key, bytes, { contentType: "image/jpeg", upsert: true });
    if (error) return classifyStorageError(error as StorageFailure);
    return { kind: "ok" };
  } catch (error) {
    return { kind: "transient", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Sends one outbox item. A claim's receipt photo goes FIRST: the desktop must
 * never see a claim whose receipt is not there, so if the photo cannot be
 * uploaded the claim is not sent and the whole item is retried (or refused)
 * together. Uploading again after a lost answer replaces the same file.
 */
export async function sendOutboxItem(
  client: SupabaseClient,
  row: OutboxRow & { updated_at: string },
  table: OutboxTable,
  attachmentPath: string | undefined,
  readBytes: (path: string) => Promise<Uint8Array>,
): Promise<SendOutcome> {
  if (table === "expense_claims" && attachmentPath) {
    const key = (row as ExpenseClaimRow).receipt_storage_key;
    if (key) {
      let bytes: Uint8Array;
      try {
        bytes = await readBytes(attachmentPath);
      } catch {
        return { kind: "rejected", message: "RECEIPT_FILE_MISSING" };
      }
      const uploaded = await uploadReceipt(client, key, bytes);
      if (uploaded.kind !== "ok") return uploaded;
    }
  }
  return sendOutboxRow(client, row, table);
}

export interface FiledClaim {
  uuid: string;
  personId: string;
  projectId: string | null;
  date: string;
  amountMinor: number;
  currency: string;
  description: string;
  supplier: string | null;
  hasReceipt: boolean;
  submittedAt: string;
  status: ClaimStatus;
  decisionReason: string | null;
  /** In the outbox and not yet in the cloud. */
  queued: boolean;
  /** The claim as the cloud holds it, so it can be withdrawn unchanged. */
  row: ExpenseClaimRow;
}

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const orNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The claims in the cloud that are not withdrawn, newest first. */
export async function loadClaims(client: SupabaseClient): Promise<FiledClaim[]> {
  const { data, error } = await client
    .from("expense_claims")
    .select("uuid,person_id,project_id,date,amount_minor,currency,description,supplier,receipt_storage_key,receipt_sha256,submitted_at,created_at,decision,decision_reason")
    .is("deleted_at", null)
    .order("submitted_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`expense_claims: ${error.message}`);
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    row: {
      uuid: str(row.uuid),
      person_id: str(row.person_id),
      project_id: orNull(row.project_id),
      date: str(row.date),
      amount_minor: Number(row.amount_minor) || 0,
      currency: str(row.currency),
      description: str(row.description),
      supplier: orNull(row.supplier),
      receipt_storage_key: orNull(row.receipt_storage_key),
      receipt_sha256: orNull(row.receipt_sha256),
      submitted_at: str(row.submitted_at),
      created_at: str(row.created_at),
      deleted_at: null,
    },
    uuid: str(row.uuid),
    personId: str(row.person_id),
    projectId: orNull(row.project_id),
    date: str(row.date),
    amountMinor: Number(row.amount_minor) || 0,
    currency: str(row.currency),
    description: str(row.description),
    supplier: orNull(row.supplier),
    hasReceipt: orNull(row.receipt_storage_key) !== null,
    submittedAt: str(row.submitted_at),
    status: claimStatus(orNull(row.decision)),
    decisionReason: orNull(row.decision_reason),
    queued: false,
  }));
}

/**
 * The list the screen shows: the cloud's claims with this phone's queued ones
 * laid over them. A queued withdrawal hides the claim; a claim filed but not yet
 * sent appears as waiting.
 */
export function mergeClaimsWithQueue(cloud: FiledClaim[], items: QueueItem[]): FiledClaim[] {
  const byUuid = new Map<string, FiledClaim>(cloud.map((claim) => [claim.uuid, claim]));
  for (const item of items) {
    if (item.table !== "expense_claims") continue;
    const row = item.row;
    if (item.status === "sent") {
      // Already in the cloud; its decision shows once the list is reloaded.
      if (row.deleted_at != null) byUuid.delete(row.uuid);
      else if (!byUuid.has(row.uuid)) byUuid.set(row.uuid, fromRow(row, false));
      continue;
    }
    if (row.deleted_at != null) byUuid.delete(row.uuid);
    else byUuid.set(row.uuid, fromRow(row, true));
  }
  return [...byUuid.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.date.localeCompare(a.date));
}

function fromRow(row: ExpenseClaimRow, queued: boolean): FiledClaim {
  return {
    row,
    uuid: row.uuid,
    personId: row.person_id,
    projectId: row.project_id,
    date: row.date,
    amountMinor: row.amount_minor,
    currency: row.currency,
    description: row.description,
    supplier: row.supplier,
    hasReceipt: row.receipt_storage_key !== null,
    submittedAt: row.submitted_at,
    status: "pending",
    decisionReason: null,
    queued,
  };
}
