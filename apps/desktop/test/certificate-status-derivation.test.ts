import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { raw, rawExec, rawOne, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import {
  createCertificate,
  getCertificate,
  nextCertificateSeq,
  setCertificateStatus,
} from "../src/repositories/certificates";
import {
  createPayment,
  deletePayment,
  reconcileCertificateStatuses,
  updatePayment,
} from "../src/repositories/payments";

/**
 * Milestone 1: certificate collection status is derived from payment evidence,
 * never asserted by a caller.
 *
 * These tests drive the real repository functions, so they exercise the same
 * reconciliation the Rust command layer performs — the harness runs the
 * non-Tauri branch, and both branches read the same rows and apply the same
 * shared rule (see fixtures/certificate-financials.json).
 *
 * Every assertion reads the DATABASE, because the whole point of the milestone
 * is that stored status follows stored evidence.
 */

beforeEach(() => resetDb());

interface ContractTerms {
  valueMinor?: number;
  vatBp?: number;
  retentionBp?: number;
  withholdingBp?: number;
  advanceMinor?: number;
  advanceRecoveryMethod?: "PROPORTIONAL" | "MANUAL";
}

let workspaceSeq = 0;

async function workspace(terms: ContractTerms = {}) {
  workspaceSeq += 1;
  const clientId = await createClient({
    name: `Client ${workspaceSeq}`, company: null, address: null, phone: null,
    email: null, taxNumber: null, contacts: null, notes: null,
  });
  const projectId = await createProject(`PRJ-2026-${String(workspaceSeq).padStart(3, "0")}`, {
    name: `Project ${workspaceSeq}`, clientId, country: null, city: null, manager: null,
    discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP",
    fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null,
  });
  const contractId = await createContract({
    projectId, number: `C-${workspaceSeq}`, title: null,
    valueMinor: terms.valueMinor ?? 1_000_000,
    vatBp: terms.vatBp ?? 0,
    retentionBp: terms.retentionBp ?? 0,
    withholdingBp: terms.withholdingBp ?? 0,
    advanceMinor: terms.advanceMinor ?? 0,
    advanceRecoveryMethod: terms.advanceRecoveryMethod ?? "PROPORTIONAL",
    performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null,
    paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM",
    milestones: null, drawings: null, attachments: null, signedDate: null, notes: null,
  });
  return { projectId, contractId };
}

async function certificate(
  contractId: number,
  grossMinor: number,
  status: "DRAFT" | "SUBMITTED" | "APPROVED" = "APPROVED",
  manualAdvanceRecoveryMinor: number | null = null,
) {
  const seq = await nextCertificateSeq(contractId);
  return createCertificate(seq, {
    contractId, number: `PC-${contractId}-${seq}`, date: "2026-07-01",
    submissionDate: "2026-07-01", dueDateOverride: null, description: null,
    grossMinor, discountMinor: 0, manualAdvanceRecoveryMinor, status,
  });
}

const cash = (contractId: number, number: string, amountMinor: number) => ({
  contractId, kind: "CERTIFICATE" as const, number, date: "2026-07-02",
  amountMinor, method: "CASH" as const, bank: null, reference: "receipt", notes: null,
});

const statusOf = async (id: number) => (await getCertificate(id))?.status;

/**
 * Gross less discount — the certified BASE, not the net payable. Net payable
 * subtracts retention, withholding and advance recovery from this.
 */
const certifiedBaseOf = (id: number) =>
  rawOne<{ n: number }>(`SELECT gross_minor - discount_minor AS n FROM payment_certificates WHERE id=${id}`)?.n ?? 0;

describe("collection status follows payment evidence", () => {
  it("settles an approved certificate on full payment", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    await createPayment(cash(contractId, "FULL", 10_000), [{ certificateId: id, amountMinor: 10_000 }]);
    expect(await statusOf(id)).toBe("PAID");
  });

  it("leaves an approved certificate open on partial payment", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    await createPayment(cash(contractId, "PART", 9_999), [{ certificateId: id, amountMinor: 9_999 }]);
    expect(await statusOf(id)).toBe("APPROVED");
  });

  it("settles once several payments together cover net payable", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    await createPayment(cash(contractId, "P1", 4_000), [{ certificateId: id, amountMinor: 4_000 }]);
    expect(await statusOf(id)).toBe("APPROVED");
    await createPayment(cash(contractId, "P2", 6_000), [{ certificateId: id, amountMinor: 6_000 }]);
    expect(await statusOf(id)).toBe("PAID");
  });

  it("reopens when a payment is edited downward", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    const paymentId = await createPayment(cash(contractId, "FULL", 10_000), [{ certificateId: id, amountMinor: 10_000 }]);
    expect(await statusOf(id)).toBe("PAID");
    await updatePayment(paymentId, cash(contractId, "FULL", 6_000), [{ certificateId: id, amountMinor: 6_000 }]);
    expect(await statusOf(id)).toBe("APPROVED");
  });

  it("settles when a payment is edited upward", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    const paymentId = await createPayment(cash(contractId, "PART", 6_000), [{ certificateId: id, amountMinor: 6_000 }]);
    expect(await statusOf(id)).toBe("APPROVED");
    await updatePayment(paymentId, cash(contractId, "PART", 10_000), [{ certificateId: id, amountMinor: 10_000 }]);
    expect(await statusOf(id)).toBe("PAID");
  });

  it("reopens when the settling payment is voided", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    const paymentId = await createPayment(cash(contractId, "FULL", 10_000), [{ certificateId: id, amountMinor: 10_000 }]);
    expect(await statusOf(id)).toBe("PAID");
    await deletePayment(paymentId);
    expect(await statusOf(id)).toBe("APPROVED");
    // The voided payment's allocation survives as history but stops counting.
    expect(raw("SELECT id FROM payment_certificate_allocations")).toHaveLength(1);
  });

  /** The union case: reallocating must reopen the certificate left behind. */
  it("updates both the old and the new certificate when a payment is reallocated", async () => {
    const { contractId } = await workspace();
    const first = await certificate(contractId, 10_000);
    const second = await certificate(contractId, 10_000);
    const paymentId = await createPayment(cash(contractId, "MOVE", 10_000), [{ certificateId: first, amountMinor: 10_000 }]);
    expect(await statusOf(first)).toBe("PAID");
    expect(await statusOf(second)).toBe("APPROVED");

    await updatePayment(paymentId, cash(contractId, "MOVE", 10_000), [{ certificateId: second, amountMinor: 10_000 }]);
    expect(await statusOf(first)).toBe("APPROVED");
    expect(await statusOf(second)).toBe("PAID");
  });

  it("keeps collection from bypassing approval", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000, "SUBMITTED");
    await createPayment(cash(contractId, "EARLY", 10_000), [{ certificateId: id, amountMinor: 10_000 }]);
    // Cash arrived, but nobody approved the claim.
    expect(await statusOf(id)).toBe("SUBMITTED");
    await setCertificateStatus(id, "APPROVED");
    // Approval alone now settles it, because the evidence was already there.
    expect(await statusOf(id)).toBe("PAID");
  });

  it("refuses allocations against a draft certificate", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000, "DRAFT");
    await expect(
      createPayment(cash(contractId, "DRAFT-PAY", 10_000), [{ certificateId: id, amountMinor: 10_000 }]),
    ).rejects.toThrow("ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE");
    expect(await statusOf(id)).toBe("DRAFT");
    expect(raw("SELECT id FROM payments")).toHaveLength(0);
  });

  it("refuses an allocation to a certificate of another contract", async () => {
    const first = await workspace();
    const second = await workspace();
    const foreign = await certificate(second.contractId, 10_000);
    await expect(
      createPayment(cash(first.contractId, "CROSS", 10_000), [{ certificateId: foreign, amountMinor: 10_000 }]),
    ).rejects.toThrow(/ALLOCATION_CONTRACT_MISMATCH|CERTIFICATE_NOT_FOUND/);
    expect(await statusOf(foreign)).toBe("APPROVED");
    expect(raw("SELECT id FROM payments")).toHaveLength(0);
  });
});

describe("net payable drives the settlement threshold", () => {
  it("uses VAT, retention and withholding, not the gross amount", async () => {
    // base 10 000; VAT +1 400; retention −500; withholding −300 → 10 600
    const { contractId } = await workspace({ vatBp: 1400, retentionBp: 500, withholdingBp: 300 });
    const id = await certificate(contractId, 10_000);
    expect(certifiedBaseOf(id)).toBe(10_000);

    await createPayment(cash(contractId, "GROSS", 10_000), [{ certificateId: id, amountMinor: 10_000 }]);
    expect(await statusOf(id)).toBe("APPROVED");

    const top = await createPayment(cash(contractId, "TOP", 600), [{ certificateId: id, amountMinor: 600 }]);
    expect(await statusOf(id)).toBe("PAID");
    expect(top).toBeGreaterThan(0);
  });

  it("recovers a proportional advance before settling", async () => {
    // advance 200 000 of 1 000 000 → 20% of a 10 000 base is recovered.
    const { contractId } = await workspace({ advanceMinor: 200_000 });
    const id = await certificate(contractId, 10_000);
    await createPayment(cash(contractId, "NET", 8_000), [{ certificateId: id, amountMinor: 8_000 }]);
    expect(await statusOf(id)).toBe("PAID");
  });

  it("recovers a manual advance before settling", async () => {
    const { contractId } = await workspace({ advanceMinor: 200_000, advanceRecoveryMethod: "MANUAL" });
    const id = await certificate(contractId, 10_000, "APPROVED", 2_500);
    await createPayment(cash(contractId, "NET", 7_500), [{ certificateId: id, amountMinor: 7_500 }]);
    expect(await statusOf(id)).toBe("PAID");
  });

  /** Advance recovery is cumulative in seq order, so later certificates differ. */
  it("threads advance recovery across certificates in sequence", async () => {
    const { contractId } = await workspace({ advanceMinor: 15_000, valueMinor: 100_000 });
    const first = await certificate(contractId, 50_000);
    const second = await certificate(contractId, 50_000);

    // First: base 50 000, proportional recovery 7 500 → 42 500.
    await createPayment(cash(contractId, "A", 42_500), [{ certificateId: first, amountMinor: 42_500 }]);
    expect(await statusOf(first)).toBe("PAID");

    // Second: remaining advance is 7 500 → 42 500 again.
    await createPayment(cash(contractId, "B", 42_500), [{ certificateId: second, amountMinor: 42_500 }]);
    expect(await statusOf(second)).toBe("PAID");
  });

  it("respects historical snapshots when contract terms change later", async () => {
    const { contractId } = await workspace({ vatBp: 0 });
    const id = await certificate(contractId, 10_000);
    // Terms move after the certificate was issued; its snapshot must win.
    await import("../src/lib/db").then(({ execute }) =>
      execute("UPDATE contracts SET vat_bp=$1 WHERE id=$2", [2_500, contractId]));
    await createPayment(cash(contractId, "SNAP", 10_000), [{ certificateId: id, amountMinor: 10_000 }]);
    expect(await statusOf(id)).toBe("PAID");
  });
});

describe("reconciliation takes identities, never a status", () => {
  it("exposes no way for a caller to assert a status", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/repositories/payments.ts"), "utf8");
    // The old shape posted {certificateId, status} payloads to Rust.
    expect(source).not.toMatch(/statusUpdates/);
    expect(source).not.toMatch(/deriveStatusUpdates|applyStatusUpdates/);

    const rust = readFileSync(resolve(import.meta.dirname, "../src-tauri/src/lib.rs"), "utf8");
    expect(rust).not.toMatch(/CertificateStatusCommandInput|apply_certificate_statuses/);
    // Payment commands must not accept a status argument at all.
    expect(rust).not.toMatch(/status_updates/);
  });

  it("repairs a status that no longer matches the evidence", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    await createPayment(cash(contractId, "FULL", 10_000), [{ certificateId: id, amountMinor: 10_000 }]);
    expect(await statusOf(id)).toBe("PAID");

    // Simulate drift, as a sync pull could produce.
    await import("../src/lib/db").then(({ execute }) =>
      execute("UPDATE payment_certificates SET status=$1 WHERE id=$2", ["APPROVED", id]));
    expect(await reconcileCertificateStatuses([id])).toBe(1);
    expect(await statusOf(id)).toBe("PAID");
  });

  it("never promotes a draft during a bulk reconciliation", async () => {
    const { contractId } = await workspace();
    const draft = await certificate(contractId, 10_000, "DRAFT");
    await reconcileCertificateStatuses();
    expect(await statusOf(draft)).toBe("DRAFT");
  });
});

/**
 * The read model counts allocations only from live CERTIFICATE-kind payments,
 * while reconciliation resolves "collected" from the same rows. Those two
 * definitions can only agree because the SCHEMA forbids an allocation from ever
 * being attached to a non-certificate payment — in both directions. If a future
 * migration relaxed either trigger, status and displayed figures would diverge,
 * so the invariant is asserted here rather than assumed.
 */
describe("the schema binds allocations to certificate payments", () => {
  it("refuses an allocation against an advance payment", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    await createPayment(
      { contractId, kind: "ADVANCE", number: "ADV-1", date: "2026-07-02", amountMinor: 10_000, method: "CASH", bank: null, reference: null, notes: null },
      [],
    );
    const advanceId = rawOne<{ id: number }>("SELECT id FROM payments WHERE number='ADV-1'")!.id;
    expect(() =>
      rawExec(`INSERT INTO payment_certificate_allocations(payment_id,certificate_id,amount_minor) VALUES(${advanceId},${id},10000)`),
    ).toThrow(/ALLOCATION_REQUIRES_ACTIVE_CERTIFICATE_PAYMENT/);
  });

  it("refuses turning a settled payment into an advance", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    const paymentId = await createPayment(cash(contractId, "FULL", 10_000), [{ certificateId: id, amountMinor: 10_000 }]);
    expect(await statusOf(id)).toBe("PAID");
    expect(() => rawExec(`UPDATE payments SET kind='ADVANCE' WHERE id=${paymentId}`))
      .toThrow(/ALLOCATIONS_REQUIRE_CERTIFICATE_PAYMENT/);
    expect(await statusOf(id)).toBe("PAID");
  });
});

describe("a failure before commit leaves no trace", () => {
  it("rolls back payment, allocations and status together", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    // The second allocation exceeds the certificate's capacity, so the whole
    // write must be rejected before anything is stored.
    await expect(
      createPayment(cash(contractId, "BAD", 20_000), [
        { certificateId: id, amountMinor: 10_000 },
        { certificateId: id, amountMinor: 10_000 },
      ]),
    ).rejects.toThrow();
    expect(raw("SELECT id FROM payments")).toHaveLength(0);
    expect(raw("SELECT id FROM payment_certificate_allocations")).toHaveLength(0);
    expect(await statusOf(id)).toBe("APPROVED");
  });
});

/**
 * M4: a certificate whose payable nets to zero could never settle.
 *
 * The rule required a POSITIVE net payable before it would return PAID, so any
 * certificate fully consumed by advance recovery, retention and withholding sat
 * at APPROVED permanently — reported as an open claim for money nobody would
 * ever pay, and re-examined by every reconciliation pass. On a contract billed
 * fully in advance that is every certificate on the job.
 *
 * The fix distinguishes "nothing was claimed" from "the claim was fully offset"
 * using the certified base, so an empty certificate is still left alone.
 */
describe("a certificate with nothing left to collect is settled", () => {
  it("settles certified work fully consumed by a 100% advance, with no payment", async () => {
    // Advance equals the contract value, so proportional recovery consumes the
    // whole base of every certificate: net payable is exactly zero.
    const { contractId } = await workspace({
      valueMinor: 100_000,
      advanceMinor: 100_000,
      vatBp: 0,
      retentionBp: 0,
      withholdingBp: 0,
    });
    const id = await certificate(contractId, 40_000);
    // Real certified work: the base is positive, and proportional recovery of a
    // 100% advance consumes all of it, so the net payable is exactly zero.
    expect(certifiedBaseOf(id)).toBe(40_000);

    await reconcileCertificateStatuses([id]);
    expect(await statusOf(id)).toBe("PAID");
  });

  it("leaves an empty certificate alone, because it claims nothing", async () => {
    const { contractId } = await workspace({ vatBp: 0, retentionBp: 0, withholdingBp: 0 });
    const id = await certificate(contractId, 0);
    expect(certifiedBaseOf(id)).toBe(0);

    await reconcileCertificateStatuses([id]);
    expect(await statusOf(id)).toBe("APPROVED");
  });

  it("never promotes a submitted certificate that nets to zero past approval", async () => {
    const { contractId } = await workspace({
      valueMinor: 100_000,
      advanceMinor: 100_000,
      vatBp: 0,
      retentionBp: 0,
      withholdingBp: 0,
    });
    const id = await certificate(contractId, 40_000, "SUBMITTED");

    await reconcileCertificateStatuses([id]);
    expect(await statusOf(id)).toBe("SUBMITTED");
  });

  it("keeps a partly-recovered certificate open until its remainder is collected", async () => {
    // Recovery takes 20% of the base; the remaining 80% is still owed, so this
    // must NOT be swept up by the zero-payable rule.
    const { contractId } = await workspace({ valueMinor: 100_000, advanceMinor: 20_000 });
    const id = await certificate(contractId, 10_000);
    expect(certifiedBaseOf(id)).toBe(10_000);

    // Recovery takes 2 000 of the 10 000 base, so 8 000 is still owed and the
    // certificate must stay open rather than being swept up as "fully offset".
    await reconcileCertificateStatuses([id]);
    expect(await statusOf(id)).toBe("APPROVED");
    await createPayment(cash(contractId, "REST", 8_000), [{ certificateId: id, amountMinor: 8_000 }]);
    expect(await statusOf(id)).toBe("PAID");
  });
});

/**
 * M6: voiding guarded only `voided_at IS NULL`, so a payment already retired
 * from the ledger could be voided again — stamping a fresh void date and reason
 * over a record that left the books earlier.
 */
describe("an already-retired payment cannot be voided again", () => {
  it("refuses a second void and leaves the original evidence untouched", async () => {
    const { contractId } = await workspace();
    const id = await certificate(contractId, 10_000);
    const paymentId = await createPayment(cash(contractId, "ONCE", 10_000), [
      { certificateId: id, amountMinor: 10_000 },
    ]);
    expect(await statusOf(id)).toBe("PAID");

    await deletePayment(paymentId, "first void");
    const afterFirst = rawOne<{ void_reason: string; voided_at: string }>(
      `SELECT void_reason, voided_at FROM payments WHERE id=${paymentId}`,
    );

    await expect(deletePayment(paymentId, "second void")).rejects.toThrow();

    const afterSecond = rawOne<{ void_reason: string; voided_at: string }>(
      `SELECT void_reason, voided_at FROM payments WHERE id=${paymentId}`,
    );
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond?.void_reason).toBe("first void");
  });

  it("refuses to void a payment that was soft-deleted without being voided", async () => {
    const { contractId } = await workspace();
    const paymentId = await createPayment(cash(contractId, "SOFT", 5_000), []);
    // Legacy shape: retired from the ledger with no void evidence recorded.
    rawExec(`UPDATE payments SET deleted_at='2026-01-01T00:00:00Z' WHERE id=${paymentId}`);

    await expect(deletePayment(paymentId, "late void")).rejects.toThrow();

    const row = rawOne<{ deleted_at: string; voided_at: string | null }>(
      `SELECT deleted_at, voided_at FROM payments WHERE id=${paymentId}`,
    );
    expect(row?.deleted_at).toBe("2026-01-01T00:00:00Z");
    expect(row?.voided_at).toBeNull();
  });
});
