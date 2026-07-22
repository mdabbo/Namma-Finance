import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { raw, rawExec, rawOne, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createCertificate, getCertificate, nextCertificateSeq, setCertificateStatus } from "../src/repositories/certificates";
import { createPayment, deletePayment, listPayments, updatePayment, validateSyncedAllocation } from "../src/repositories/payments";
import { listSuspectedSyntheticPayments } from "../src/repositories/paymentIntegrity";

beforeEach(() => resetDb());

async function fixture(certificateNumber = "PC-1") {
  const clientId = await createClient({ name: "Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject(`PRJ-${certificateNumber}`, { name: "Project", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
  const contractId = await createContract({ projectId, number: `C-${certificateNumber}`, title: null, valueMinor: 100_000_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
  const certificateId = await createCertificate(await nextCertificateSeq(contractId), { contractId, number: certificateNumber, date: "2026-07-01", submissionDate: "2026-07-01", dueDateOverride: null, description: null, grossMinor: 10_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
  return { contractId, certificateId };
}

const payment = (contractId: number, number = "REAL-1", amountMinor = 10_000) => ({ contractId, kind: "CERTIFICATE" as const, number, date: "2026-07-02", amountMinor, method: "CASH" as const, bank: null, reference: "receipt", notes: null });

describe("payment evidence controls certificate status", () => {
  it("rejects manually setting PAID without a payment", async () => {
    const { certificateId } = await fixture();
    await expect(setCertificateStatus(certificateId, "PAID")).rejects.toThrow("PAID_REQUIRES_PAYMENT");
    expect((await getCertificate(certificateId))?.status).toBe("APPROVED");
  });

  it("promotes on full allocation but not partial allocation", async () => {
    const { contractId, certificateId } = await fixture();
    const id = await createPayment(payment(contractId, "PART", 9_999), [{ certificateId, amountMinor: 9_999 }]);
    expect((await getCertificate(certificateId))?.status).toBe("APPROVED");
    await updatePayment(id, payment(contractId, "FULL"), [{ certificateId, amountMinor: 10_000 }]);
    expect((await getCertificate(certificateId))?.status).toBe("PAID");
  });

  it("reopens after payment reduction or deletion", async () => {
    const { contractId, certificateId } = await fixture();
    const id = await createPayment(payment(contractId), [{ certificateId, amountMinor: 10_000 }]);
    await updatePayment(id, payment(contractId, "REDUCED", 5_000), [{ certificateId, amountMinor: 5_000 }]);
    expect((await getCertificate(certificateId))?.status).toBe("APPROVED");
    await updatePayment(id, payment(contractId), [{ certificateId, amountMinor: 10_000 }]);
    await deletePayment(id);
    expect((await getCertificate(certificateId))?.status).toBe("APPROVED");
  });

  it("reconciles both certificates when a payment is reallocated", async () => {
    const first = await fixture("PC-A");
    const secondId = await createCertificate(await nextCertificateSeq(first.contractId), { contractId: first.contractId, number: "PC-B", date: "2026-07-01", submissionDate: "2026-07-01", dueDateOverride: null, description: null, grossMinor: 10_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    const id = await createPayment(payment(first.contractId), [{ certificateId: first.certificateId, amountMinor: 10_000 }]);
    await updatePayment(id, payment(first.contractId), [{ certificateId: secondId, amountMinor: 10_000 }]);
    expect((await getCertificate(first.certificateId))?.status).toBe("APPROVED");
    expect((await getCertificate(secondId))?.status).toBe("PAID");
  });

  it("rejects cross-contract allocation without creating money", async () => {
    const first = await fixture("PC-X");
    const second = await fixture("PC-Y");
    await expect(createPayment(payment(first.contractId), [{ certificateId: second.certificateId, amountMinor: 10_000 }]))
      .rejects.toThrow("ALLOCATION_CONTRACT_MISMATCH");
    expect(raw("SELECT id FROM payments")).toHaveLength(0);
  });

  it("keeps the original payment intact when an update allocation is invalid", async () => {
    const { contractId, certificateId } = await fixture();
    const id = await createPayment(payment(contractId), [{ certificateId, amountMinor: 10_000 }]);
    await expect(updatePayment(id, payment(contractId, "BAD"), [{ certificateId: 999_999, amountMinor: 10_000 }]))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");
    expect(rawOne<{ number: string }>(`SELECT number FROM payments WHERE id=${id}`)?.number).toBe("REAL-1");
    expect(rawOne<{ certificate_id: number }>(`SELECT certificate_id FROM payment_certificate_allocations WHERE payment_id=${id}`)?.certificate_id).toBe(certificateId);
  });

  it("reopens when an edited certificate increases above collected cash", async () => {
    const { contractId, certificateId } = await fixture();
    await createPayment(payment(contractId), [{ certificateId, amountMinor: 10_000 }]);
    const cert = (await getCertificate(certificateId))!;
    await import("../src/repositories/certificates").then(({ updateCertificate }) => updateCertificate(certificateId, {
      contractId, number: cert.number, date: cert.date, submissionDate: cert.submissionDate,
      dueDateOverride: cert.dueDateOverride, description: cert.description, grossMinor: 10_001,
      discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED",
    }));
    expect((await getCertificate(certificateId))?.status).toBe("APPROVED");
  });

  it("cannot hide allocated cash by reverting a certificate to draft", async () => {
    const { contractId, certificateId } = await fixture();
    await createPayment(payment(contractId, "PART", 5_000), [{ certificateId, amountMinor: 5_000 }]);
    await expect(setCertificateStatus(certificateId, "DRAFT")).rejects.toThrow("ALLOCATED_CERTIFICATE_CANNOT_BE_DRAFT");
  });

  it("rolls back the payment if an allocation fails", async () => {
    const { contractId } = await fixture();
    await expect(createPayment(payment(contractId), [{ certificateId: 999_999, amountMinor: 10_000 }])).rejects.toThrow();
    expect(raw("SELECT id FROM payments")).toHaveLength(0);
  });

  it("rejects duplicate allocations and allocations above the payment amount", async () => {
    const { contractId, certificateId } = await fixture();
    await expect(createPayment(payment(contractId), [
      { certificateId, amountMinor: 5_000 }, { certificateId, amountMinor: 5_000 },
    ])).rejects.toThrow("DUPLICATE_CERTIFICATE_ALLOCATION");
    await expect(createPayment(payment(contractId, "OVER", 10_000), [
      { certificateId, amountMinor: 10_001 },
    ])).rejects.toThrow("ALLOCATIONS_EXCEED_PAYMENT");
    expect(raw("SELECT id FROM payments")).toHaveLength(0);
  });

  it("rejects allocation above the certificate unpaid balance", async () => {
    const { contractId, certificateId } = await fixture();
    await expect(createPayment(payment(contractId, "OVER-DUE", 20_000), [
      { certificateId, amountMinor: 10_001 },
    ])).rejects.toThrow("ALLOCATION_EXCEEDS_CERTIFICATE_UNPAID");
    expect(raw("SELECT id FROM payments")).toHaveLength(0);
  });

  it("rejects draft, archived, and voided certificate allocation at database level", async () => {
    const { contractId } = await fixture();
    const draftId = await createCertificate(await nextCertificateSeq(contractId), { contractId, number: "PC-DRAFT", date: "2026-07-01", submissionDate: null, dueDateOverride: null, description: null, grossMinor: 10_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "DRAFT" });
    await expect(createPayment(payment(contractId, "DRAFT"), [{ certificateId: draftId, amountMinor: 1_000 }]))
      .rejects.toThrow("ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE");

    const paymentId = await createPayment(payment(contractId, "CREDIT"), []);
    rawExec(`UPDATE payment_certificates SET archived_at=datetime('now') WHERE id=${draftId}`);
    expect(() => rawExec(`INSERT INTO payment_certificate_allocations (payment_id,certificate_id,amount_minor) VALUES (${paymentId},${draftId},100)`))
      .toThrow("ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE");
  });

  it("shows unallocated certificate money explicitly as customer credit", async () => {
    const { contractId } = await fixture();
    await createPayment(payment(contractId, "CREDIT", 12_345), []);
    await createPayment({ ...payment(contractId, "ADV", 5_000), kind: "ADVANCE" }, []);
    const rows = await listPayments();
    expect(rows.find((row) => row.number === "CREDIT")?.unallocatedMinor).toBe(12_345);
    expect(rows.find((row) => row.number === "ADV")?.unallocatedMinor).toBe(0);
  });

  it("rejects sync allocations above calculated certificate capacity", async () => {
    const { contractId, certificateId } = await fixture();
    const paymentId = await createPayment(payment(contractId, "SYNC-CREDIT", 20_000), []);
    await expect(validateSyncedAllocation(paymentId, certificateId, 10_001))
      .rejects.toThrow("ALLOCATION_EXCEEDS_CERTIFICATE_UNPAID");
    await expect(validateSyncedAllocation(paymentId, certificateId, 10_000)).resolves.toBeUndefined();
  });

  it("never collapses preserved duplicate rows during ordinary payment editing", async () => {
    const { contractId, certificateId } = await fixture();
    const paymentId = await createPayment(payment(contractId, "LEGACY", 10_000), [{ certificateId, amountMinor: 9_000 }]);
    rawExec("DROP TRIGGER validate_allocation_insert");
    rawExec(`INSERT INTO payment_certificate_allocations (payment_id,certificate_id,amount_minor,integrity_exception) VALUES (${paymentId},${certificateId},1000,1)`);

    await expect(updatePayment(paymentId, payment(contractId, "EDITED", 10_000), [{ certificateId, amountMinor: 10_000 }]))
      .rejects.toThrow("LEGACY_DUPLICATE_ALLOCATIONS_REQUIRE_REVIEW");
    expect(raw<{ amount_minor: number }>(`SELECT amount_minor FROM payment_certificate_allocations WHERE payment_id=${paymentId} ORDER BY id`))
      .toEqual([{ amount_minor: 9_000 }, { amount_minor: 1_000 }]);
    expect(rawOne<{ number: string }>(`SELECT number FROM payments WHERE id=${paymentId}`)?.number).toBe("LEGACY");
  });
});

describe("legacy synthetic-payment detection", () => {
  it("is deterministic, read-only, and excludes ordinary evidence", async () => {
    const { contractId, certificateId } = await fixture();
    const today = new Date().toISOString().slice(0, 10);
    await createPayment({ ...payment(contractId, "PAY-PC-1"), date: today, method: "BANK_TRANSFER", reference: null }, [{ certificateId, amountMinor: 10_000 }]);
    expect(await listSuspectedSyntheticPayments()).toHaveLength(1);
    expect(await listSuspectedSyntheticPayments()).toHaveLength(1);
    expect(rawOne<{ count: number }>("SELECT COUNT(*) AS count FROM payments")?.count).toBe(1);
  });
});
