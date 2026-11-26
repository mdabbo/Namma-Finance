import { currencyInfo } from "@mep/core";
import { addDays, localIsoDate } from "./timeEntryForm";
import { parseAmountMinor } from "./team";
import type { ExpenseClaimRow } from "./timeQueue";

/**
 * The rules of the phone's expense-claim form, free of React Native so the
 * desktop test suite can hold them in place.
 *
 * A claim is not an expense: the office accepts or rejects it on the desktop,
 * and only accepting creates an expense. So the phone asks for what the office
 * needs to judge it (who, what, how much, when, a photo) and nothing it must
 * decide: no category (the office picks it), no exchange rate.
 */

/** How many days back the form offers a receipt date (today and the 30 before). */
export const CLAIM_DATE_DAYS = 30;

export const claimDates = (today: string): string[] => Array.from({ length: CLAIM_DATE_DAYS + 1 }, (_, i) => addDays(today, -i));

/** The receipt's long edge in pixels, and its JPEG quality, after compression. */
export const RECEIPT_MAX_EDGE = 1600;
export const RECEIPT_QUALITY = 0.7;
/** A photo larger than this after compression is refused rather than uploaded. */
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

/** Currencies a claim can be in: the ones the office works in first. */
export const CLAIM_CURRENCIES = ["EGP", "SAR", "USD", "EUR", "AED", "GBP"] as const;

export interface ClaimDraft {
  personId: string | null;
  projectId: string | null;
  date: string;
  amount: string;
  currency: string;
  description: string;
  supplier: string;
  /** The compressed photo kept on the phone, if one was taken. */
  receipt: ClaimReceipt | null;
}

export interface ClaimReceipt {
  /** Where the compressed JPEG is kept until it has been uploaded. */
  path: string;
  /** SHA-256 of exactly those bytes, lower-case hex. */
  sha256: string;
  sizeBytes: number;
}

export type ClaimError = "person" | "amount" | "date" | "description" | "currency" | "receipt";

/**
 * Where a claim's receipt is stored: the folder named for the login that
 * uploads it, then the claim's own uuid. The cloud refuses any other name
 * (supabase-0025), so a claim can only ever point at its own photo.
 */
export function receiptKey(userId: string, claimUuid: string): string {
  return `${userId.toLowerCase()}/claims/${claimUuid.toLowerCase()}.jpg`;
}

/** Fields that are wrong, as the form shows them. A receipt is optional. */
export function validateClaim(draft: ClaimDraft, today: string): ClaimError[] {
  const errors: ClaimError[] = [];
  if (!draft.personId) errors.push("person");
  if (!(CLAIM_CURRENCIES as readonly string[]).includes(draft.currency)) errors.push("currency");
  else if (parseAmountMinor(draft.amount, currencyInfo(draft.currency).exponent) === null) errors.push("amount");
  // A receipt cannot be from the future; yesterday's is fine, and so is an old one
  // (people claim late). The cloud allows one day of slack for offices ahead of UTC.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || draft.date > addDays(today, 1)) errors.push("date");
  if (!draft.description.trim()) errors.push("description");
  if (draft.receipt && draft.receipt.sizeBytes > RECEIPT_MAX_BYTES) errors.push("receipt");
  return errors;
}

/** The row the outbox sends for a valid draft. */
export function claimRow(
  draft: ClaimDraft,
  ids: { uuid: string; userId: string; createdAt: string; submittedAt: string },
): ExpenseClaimRow {
  return {
    uuid: ids.uuid,
    person_id: draft.personId!,
    project_id: draft.projectId,
    date: draft.date,
    amount_minor: parseAmountMinor(draft.amount, currencyInfo(draft.currency).exponent)!,
    currency: draft.currency,
    description: draft.description.trim(),
    supplier: draft.supplier.trim() || null,
    receipt_storage_key: draft.receipt ? receiptKey(ids.userId, ids.uuid) : null,
    receipt_sha256: draft.receipt ? draft.receipt.sha256 : null,
    submitted_at: ids.submittedAt,
    created_at: ids.createdAt,
    deleted_at: null,
  };
}

/** The same claim, withdrawn. Only a claim still waiting for a decision can be. */
export function withdrawnClaim(row: ExpenseClaimRow, now: Date): ExpenseClaimRow {
  return { ...row, deleted_at: now.toISOString() };
}

export type ClaimStatus = "pending" | "accepted" | "rejected";

export const claimStatus = (decision: string | null): ClaimStatus =>
  decision === "ACCEPTED" ? "accepted" : decision === "REJECTED" ? "rejected" : "pending";

/** Base64 to bytes, for hashing the compressed photo. Null if it is not valid base64. */
export function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> | null {
  const clean = base64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  const binary = atob(clean);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Today as the form uses it. */
export const claimToday = (): string => localIsoDate(new Date());
