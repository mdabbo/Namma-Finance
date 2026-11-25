import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  bytesFromBase64,
  claimDates,
  claimRow,
  claimStatus,
  receiptKey,
  RECEIPT_MAX_BYTES,
  toHex,
  validateClaim,
  withdrawnClaim,
  type ClaimDraft,
} from "../../mobile/src/lib/claimForm";
import {
  classifyStorageError,
  loadClaims,
  mergeClaimsWithQueue,
  sendOutboxItem,
  uploadReceipt,
} from "../../mobile/src/lib/claimsCloud";
import {
  applyFlush,
  discard,
  EMPTY_QUEUE,
  enqueueClaim,
  enqueue,
  flush,
  parseQueue,
  releasedAttachments,
  type ExpenseClaimRow,
  type QueueState,
} from "../../mobile/src/lib/timeQueue";

/**
 * Expense claims from the phone (plan step F6, part 2): the form's rules, the
 * receipt's name in the cloud, and the outbox that uploads the photo BEFORE it
 * sends the claim, so the office never sees a claim with a missing receipt.
 */

const TODAY = "2026-11-25";
const USER = "A0000000-0000-4000-8000-000000000003";
const CLAIM = "C1A1C1A1-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);

const draft = (overrides: Partial<ClaimDraft> = {}): ClaimDraft => ({
  personId: "pe-1", projectId: "pr-1", date: TODAY, amount: "150", currency: "EGP", description: "Printing the drawings", supplier: "", receipt: null, ...overrides,
});
const photo = { path: "file:///docs/claim-receipts/x.jpg", sha256: SHA, sizeBytes: 300_000 };
const ids = { uuid: CLAIM, userId: USER, createdAt: "2026-11-25 08:00:00", submittedAt: "2026-11-25T08:00:00.000Z" };

describe("where a receipt is stored", () => {
  it("is the login's own folder, then the claim's uuid, in lower case", () => {
    expect(receiptKey(USER, CLAIM)).toBe("a0000000-0000-4000-8000-000000000003/claims/c1a1c1a1-0000-4000-8000-000000000001.jpg");
  });
});

describe("the claim form", () => {
  it("accepts a complete claim, with or without a photo", () => {
    expect(validateClaim(draft(), TODAY)).toEqual([]);
    expect(validateClaim(draft({ receipt: photo }), TODAY)).toEqual([]);
  });

  it("names each missing field", () => {
    expect(validateClaim(draft({ personId: null }), TODAY)).toEqual(["person"]);
    expect(validateClaim(draft({ amount: "" }), TODAY)).toEqual(["amount"]);
    expect(validateClaim(draft({ amount: "0" }), TODAY)).toEqual(["amount"]);
    expect(validateClaim(draft({ description: "   " }), TODAY)).toEqual(["description"]);
    expect(validateClaim(draft({ currency: "XYZ" }), TODAY)).toEqual(["currency"]);
  });

  it("reads the amount as text in the currency's own decimals", () => {
    expect(validateClaim(draft({ amount: "1,500.50" }), TODAY)).toEqual([]);
    expect(validateClaim(draft({ amount: "1.234" }), TODAY)).toEqual(["amount"]); // 3 decimals, a 2-decimal currency
    expect(validateClaim(draft({ amount: "١٢٥" }), TODAY)).toEqual([]);
  });

  it("refuses a date in the future but allows one day of slack and any old receipt", () => {
    expect(validateClaim(draft({ date: "2026-11-27" }), TODAY)).toEqual(["date"]);
    expect(validateClaim(draft({ date: "2026-11-26" }), TODAY)).toEqual([]);
    expect(validateClaim(draft({ date: "2026-01-02" }), TODAY)).toEqual([]);
    expect(validateClaim(draft({ date: "garbage" }), TODAY)).toEqual(["date"]);
  });

  it("refuses a photo that is still too large after compression", () => {
    expect(validateClaim(draft({ receipt: { ...photo, sizeBytes: RECEIPT_MAX_BYTES } }), TODAY)).toEqual([]);
    expect(validateClaim(draft({ receipt: { ...photo, sizeBytes: RECEIPT_MAX_BYTES + 1 } }), TODAY)).toEqual(["receipt"]);
  });

  it("offers today and the 30 days before", () => {
    const dates = claimDates(TODAY);
    expect(dates).toHaveLength(31);
    expect(dates[0]).toBe(TODAY);
    expect(dates[30]).toBe("2026-10-26");
  });
});

describe("the claim the phone sends", () => {
  it("carries what the office needs to judge it, and no category, decision or rate", () => {
    const row = claimRow(draft({ supplier: "  Copy Centre ", description: " Printing ", receipt: photo }), ids);
    expect(row).toEqual({
      uuid: CLAIM, person_id: "pe-1", project_id: "pr-1", date: TODAY, amount_minor: 15_000, currency: "EGP",
      description: "Printing", supplier: "Copy Centre",
      receipt_storage_key: receiptKey(USER, CLAIM), receipt_sha256: SHA,
      submitted_at: ids.submittedAt, created_at: ids.createdAt, deleted_at: null,
    });
    for (const field of ["category_id", "decision", "decided_at", "decided_by", "decision_reason", "fx_rate_micro"]) {
      expect(row).not.toHaveProperty(field);
    }
  });

  it("names a receipt only when there is a photo, and an overhead claim has no project", () => {
    const row = claimRow(draft({ projectId: null }), ids);
    expect(row).toMatchObject({ project_id: null, supplier: null, receipt_storage_key: null, receipt_sha256: null });
  });

  it("is withdrawn by stamping deleted_at, nothing else", () => {
    const row = claimRow(draft({ receipt: photo }), ids);
    expect(withdrawnClaim(row, new Date("2026-11-26T10:00:00Z"))).toEqual({ ...row, deleted_at: "2026-11-26T10:00:00.000Z" });
  });

  it("shows the office's decision as a status", () => {
    expect(claimStatus(null)).toBe("pending");
    expect(claimStatus("ACCEPTED")).toBe("accepted");
    expect(claimStatus("REJECTED")).toBe("rejected");
  });
});

describe("hashing the photo", () => {
  it("turns base64 into the exact bytes, and refuses anything else", () => {
    expect(Array.from(bytesFromBase64("AAEC/w==")!)).toEqual([0, 1, 2, 255]);
    expect(bytesFromBase64("AAEC/w=\n=")).not.toBeNull(); // whitespace is ignored
    expect(bytesFromBase64("not base64!")).toBeNull();
    expect(bytesFromBase64("AAE")).toBeNull();
  });

  it("writes bytes as lower-case hex", () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
    expect(toHex(new Uint8Array([1, 2]).buffer)).toBe("0102");
  });
});

describe("the outbox with claims", () => {
  const row = (overrides: Partial<ExpenseClaimRow> = {}): ExpenseClaimRow => ({ ...claimRow(draft({ receipt: photo }), ids), ...overrides });

  it("replaces a waiting claim when it is withdrawn, so the withdrawal alone is queued", () => {
    let state = enqueueClaim(EMPTY_QUEUE, row(), photo.path, "a");
    state = enqueueClaim(state, withdrawnClaim(row(), new Date()), undefined, "b");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ table: "expense_claims", rev: 2 });
    expect(state.items[0]!.row.deleted_at).not.toBeNull();
    expect(releasedAttachments(enqueueClaim(EMPTY_QUEUE, row(), photo.path, "a"), state)).toEqual([photo.path]);
  });

  it("hands the photo's path to the sender for a claim only", async () => {
    let state: QueueState = enqueueClaim(EMPTY_QUEUE, row(), photo.path, "a");
    state = enqueue(state, { uuid: "t1", person_id: "p", project_id: "pr", stage_id: null, date: TODAY, minutes: 60, billable: 1, note: null, created_at: "x", deleted_at: null }, "b");
    const seen: [string, string, string | undefined][] = [];
    await flush(state, {
      serverNow: async () => 1_000, deviceNow: () => 1_000,
      send: async (next, table, attachmentPath) => { seen.push([next.uuid, table, attachmentPath]); return { kind: "ok" }; },
    });
    expect(seen).toEqual([[CLAIM, "expense_claims", photo.path], ["t1", "time_entries", undefined]]);
  });

  it("forgets the photo's file once the claim is sent, but keeps it while the claim waits or is refused", async () => {
    const waiting = enqueueClaim(EMPTY_QUEUE, row(), photo.path, "a");
    const deps = (outcome: "ok" | "rejected") => ({
      serverNow: async () => 1_000, deviceNow: () => 1_000,
      send: async () => (outcome === "ok" ? { kind: "ok" as const } : { kind: "rejected" as const, message: "RECEIPT_UPLOAD_REFUSED" }),
    });
    const refused = applyFlush(waiting, await flush(waiting, deps("rejected")), "now");
    expect(releasedAttachments(waiting, refused)).toEqual([]);
    expect(refused.items[0]).toMatchObject({ status: "rejected", attachmentPath: photo.path });
    const sent = applyFlush(waiting, await flush(waiting, deps("ok")), "now");
    expect(sent.items[0]).toMatchObject({ status: "sent" });
    expect(sent.items[0]).not.toHaveProperty("attachmentPath");
    expect(releasedAttachments(waiting, sent)).toEqual([photo.path]);
  });

  it("releases the photo of a discarded claim, never of a time entry", () => {
    const state = enqueueClaim(EMPTY_QUEUE, row(), photo.path, "a");
    expect(releasedAttachments(state, discard(state, CLAIM))).toEqual([photo.path]);
    expect(releasedAttachments(state, state)).toEqual([]);
  });

  it("reads a stored queue that holds claims", () => {
    const state = enqueueClaim(EMPTY_QUEUE, row(), photo.path, "a");
    expect(parseQueue(JSON.stringify(state)).items[0]).toMatchObject({ table: "expense_claims", attachmentPath: photo.path });
  });
});

describe("storage errors", () => {
  it("retries a dropped connection and a login being refreshed, and refuses the cloud's no", () => {
    const kind = (error: Parameters<typeof classifyStorageError>[0]) => classifyStorageError(error);
    expect(kind({ message: "Network request failed" }).kind).toBe("transient");
    expect(kind({ message: "x", statusCode: "500" }).kind).toBe("transient");
    expect(kind({ message: "x", status: 503 }).kind).toBe("transient");
    expect(kind({ message: "jwt expired", statusCode: "401" }).kind).toBe("transient");
    expect(kind({ message: "x", statusCode: "429" }).kind).toBe("transient");
    expect(kind({ message: "new row violates row-level security policy", statusCode: "403" })).toEqual({ kind: "rejected", message: "RECEIPT_UPLOAD_REFUSED" });
    expect(kind({ message: "x", statusCode: "413" })).toEqual({ kind: "rejected", message: "RECEIPT_TOO_LARGE" });
    expect(kind({ message: "x", statusCode: "400" })).toEqual({ kind: "rejected", message: "RECEIPT_UPLOAD_REFUSED" });
  });
});

describe("sending a claim with its photo", () => {
  /** A client that records what it was asked to do, in order. */
  function recorder(options: { uploadError?: { message: string; statusCode?: string } | null; upsertError?: { code: string; message: string } | null } = {}) {
    const log: string[] = [];
    let uploaded: { bucket: string; key: string; bytes: Uint8Array; options: unknown } | null = null;
    const client = {
      storage: {
        from: (bucket: string) => ({
          upload: async (key: string, bytes: Uint8Array, opts: unknown) => {
            log.push("upload");
            uploaded = { bucket, key, bytes, options: opts };
            return { data: null, error: options.uploadError ?? null };
          },
        }),
      },
      from: (table: string) => ({
        upsert: (payload: Record<string, unknown>) => ({
          select: async () => {
            log.push(`upsert:${table}`);
            return { data: options.upsertError ? null : [{ uuid: payload.uuid }], error: options.upsertError ?? null, status: 201 };
          },
        }),
      }),
    } as unknown as SupabaseClient;
    return { client, log, uploaded: () => uploaded };
  }
  const claim = { ...claimRow(draft({ receipt: photo }), ids), updated_at: "2026-11-25T08:00:01.000Z" };
  const bytes = new Uint8Array([1, 2, 3]);
  const read = async () => bytes;

  it("uploads the photo first, to the claim's own key, then sends the claim", async () => {
    const { client, log, uploaded } = recorder();
    await expect(sendOutboxItem(client, claim, "expense_claims", photo.path, read)).resolves.toEqual({ kind: "ok" });
    expect(log).toEqual(["upload", "upsert:expense_claims"]);
    expect(uploaded()).toEqual({ bucket: "namaa-documents", key: receiptKey(USER, CLAIM), bytes, options: { contentType: "image/jpeg", upsert: true } });
  });

  it("does not send the claim when the photo cannot be uploaded", async () => {
    const dropped = recorder({ uploadError: { message: "Network request failed" } });
    expect(await sendOutboxItem(dropped.client, claim, "expense_claims", photo.path, read)).toMatchObject({ kind: "transient" });
    expect(dropped.log).toEqual(["upload"]);
    const refused = recorder({ uploadError: { message: "row-level security", statusCode: "403" } });
    expect(await sendOutboxItem(refused.client, claim, "expense_claims", photo.path, read)).toEqual({ kind: "rejected", message: "RECEIPT_UPLOAD_REFUSED" });
    expect(refused.log).toEqual(["upload"]);
  });

  it("refuses, without sending, a claim whose photo file is gone", async () => {
    const { client, log } = recorder();
    const gone = async () => { throw new Error("no such file"); };
    expect(await sendOutboxItem(client, claim, "expense_claims", photo.path, gone)).toEqual({ kind: "rejected", message: "RECEIPT_FILE_MISSING" });
    expect(log).toEqual([]);
  });

  it("sends a claim with no photo straight away, and a time entry never uploads", async () => {
    const plain = recorder();
    await sendOutboxItem(plain.client, { ...claim, receipt_storage_key: null, receipt_sha256: null }, "expense_claims", undefined, read);
    expect(plain.log).toEqual(["upsert:expense_claims"]);
    const time = recorder();
    await sendOutboxItem(time.client, claim, "time_entries", photo.path, read);
    expect(time.log).toEqual(["upsert:time_entries"]);
  });

  it("passes the cloud's refusal of the claim itself on", async () => {
    const { client } = recorder({ upsertError: { code: "42501", message: "CLAIM_NOT_OWN" } });
    expect(await sendOutboxItem(client, claim, "expense_claims", photo.path, read)).toEqual({ kind: "rejected", message: "42501" });
  });

  it("uploads again after a lost answer by replacing the same file", async () => {
    const { client, uploaded } = recorder();
    await uploadReceipt(client, receiptKey(USER, CLAIM), bytes);
    await uploadReceipt(client, receiptKey(USER, CLAIM), bytes);
    expect((uploaded()!.options as { upsert: boolean }).upsert).toBe(true);
  });

  it("turns a thrown upload into a retry", async () => {
    const client = { storage: { from: () => ({ upload: async () => { throw new TypeError("Network request failed"); } }) } } as unknown as SupabaseClient;
    expect(await uploadReceipt(client, "k", bytes)).toEqual({ kind: "transient", message: "Network request failed" });
  });
});

describe("the claims the phone shows", () => {
  const cloudRows = [
    { uuid: "c-old", person_id: "p1", project_id: null, date: "2026-11-01", amount_minor: 500, currency: "EGP", description: "Old", supplier: null, receipt_storage_key: null, receipt_sha256: null, submitted_at: "2026-11-01T09:00:00Z", created_at: "2026-11-01 09:00:00", decision: "ACCEPTED", decision_reason: null },
    { uuid: "c-no", person_id: "p1", project_id: "pr-1", date: "2026-11-10", amount_minor: 900, currency: "SAR", description: "Lunch", supplier: "Cafe", receipt_storage_key: "u/claims/c-no.jpg", receipt_sha256: SHA, submitted_at: "2026-11-10T09:00:00Z", created_at: "2026-11-10 09:00:00", decision: "REJECTED", decision_reason: "Personal purchase" },
  ];
  const clientWith = (data: unknown, error: { message: string } | null = null) => {
    const calls: string[] = [];
    const builder = {
      select: (cols: string) => { calls.push(`select:${cols}`); return builder; },
      is: (col: string, value: unknown) => { calls.push(`is:${col}:${value}`); return builder; },
      order: () => builder, limit: async () => ({ data, error }),
    };
    return { client: { from: (table: string) => { calls.push(`from:${table}`); return builder; } } as unknown as SupabaseClient, calls };
  };

  it("reads live claims with their decision, and a rejection's reason", async () => {
    const { client, calls } = clientWith(cloudRows);
    const claims = await loadClaims(client);
    expect(calls).toContain("from:expense_claims");
    expect(calls).toContain("is:deleted_at:null");
    expect(claims.map((c) => [c.uuid, c.status, c.decisionReason, c.hasReceipt])).toEqual([
      ["c-old", "accepted", null, false],
      ["c-no", "rejected", "Personal purchase", true],
    ]);
    expect(claims[1]!.row).toMatchObject({ receipt_storage_key: "u/claims/c-no.jpg", receipt_sha256: SHA, deleted_at: null });
  });

  it("fails loudly when the cloud refuses the read", async () => {
    await expect(loadClaims(clientWith(null, { message: "relation does not exist" }).client)).rejects.toThrow("expense_claims");
  });

  it("lays queued claims over the cloud's and hides withdrawn ones", async () => {
    const cloud = await loadClaims(clientWith(cloudRows).client);
    const filedNow = claimRow(draft({ description: "Just filed" }), { ...ids, uuid: "c-new" });
    let state = enqueueClaim(EMPTY_QUEUE, filedNow, undefined, "a");
    state = enqueueClaim(state, withdrawnClaim(cloud.find((c) => c.uuid === "c-old")!.row, new Date()), undefined, "b");
    const merged = mergeClaimsWithQueue(cloud, state.items);
    expect(merged.map((c) => [c.uuid, c.queued, c.status])).toEqual([
      ["c-new", true, "pending"],
      ["c-no", false, "rejected"],
    ]);
  });

  it("keeps a withdrawal hidden once it is sent, before the list is reloaded", async () => {
    const cloud = await loadClaims(clientWith(cloudRows).client);
    const queued = enqueueClaim(EMPTY_QUEUE, withdrawnClaim(cloud.find((c) => c.uuid === "c-no")!.row, new Date()), undefined, "a");
    const sent = applyFlush(queued, await flush(queued, { serverNow: async () => 1, deviceNow: () => 1, send: async () => ({ kind: "ok" }) }), "now");
    expect(sent.items[0]!.status).toBe("sent");
    expect(mergeClaimsWithQueue(cloud, sent.items).map((c) => c.uuid)).toEqual(["c-old"]);
  });
});

describe("what the phone may write", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../mobile/${path}`, import.meta.url)), "utf8");

  it("uploads files only from lib/claimsCloud.ts, into the receipt bucket", () => {
    const source = read("src/lib/claimsCloud.ts");
    expect(source.match(/\.upload\(/g)).toHaveLength(1);
    expect(source).toContain('export const RECEIPT_BUCKET = "namaa-documents";');
    expect(source).toContain("upsert: true");
  });

  it("sends a claim's photo before its row, through the tested function", () => {
    expect(read("src/hooks/useTimeQueue.tsx")).toContain("sendOutboxItem(client, row, table, attachmentPath, readReceipt)");
    const body = read("src/lib/claimsCloud.ts");
    expect(body.indexOf("await uploadReceipt(client, key, bytes)")).toBeGreaterThan(-1);
    expect(body.indexOf("await uploadReceipt(client, key, bytes)")).toBeLessThan(body.indexOf("return sendOutboxRow(client, row, table);"));
  });

  it("shrinks a photo before keeping it, and hashes the bytes it keeps", () => {
    const photoModule = read("src/lib/receiptPhoto.ts");
    expect(photoModule).toContain("RECEIPT_MAX_EDGE");
    expect(photoModule).toContain("compress: RECEIPT_QUALITY");
    expect(photoModule).toContain("Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)");
    expect(photoModule).toContain("file.write(bytes)");
  });
});
