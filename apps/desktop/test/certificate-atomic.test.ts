import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { computeCertificate } from "@mep/core";
import { raw, rawExec, rawOne, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import {
  createCertificate,
  getCertificate,
  setCertificateStatus,
  transitionCertificate,
  updateCertificate,
  voidCertificate,
} from "../src/repositories/certificates";
import { createPayment, deletePayment } from "../src/repositories/payments";
import { reserveNextNumber } from "../src/repositories/numbering";

beforeEach(() => resetDb());

let clientSeq = 0;

async function makeContract(over: Partial<{ valueMinor: number; vatBp: number; retentionBp: number; withholdingBp: number; advanceMinor: number }> = {}) {
  clientSeq += 1;
  const clientId = await createClient({ name: `Client ${clientSeq}`, company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject(`PRJ-2026-${String(100 + clientSeq).padStart(3, "0")}`, {
    name: `Project ${clientSeq}`, clientId, country: null, city: null, manager: null, discipline: "MULTI",
    projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null,
  });
  const contractId = await createContract({
    projectId, number: `C-${clientSeq}`, title: null, valueMinor: over.valueMinor ?? 100_000_000,
    vatBp: over.vatBp ?? 0, retentionBp: over.retentionBp ?? 0, withholdingBp: over.withholdingBp ?? 0,
    advanceMinor: over.advanceMinor ?? 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
    performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
    valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null,
  });
  return { projectId, contractId };
}

function certInput(contractId: number, over: Partial<{ number: string; grossMinor: number; discountMinor: number; status: "DRAFT" | "SUBMITTED" | "APPROVED" | "PAID"; date: string; submissionDate: string | null; manualAdvanceRecoveryMinor: number | null }> = {}) {
  return {
    contractId, number: over.number ?? "PC-1", date: over.date ?? "2026-02-01",
    submissionDate: over.submissionDate ?? "2026-02-01", dueDateOverride: null, description: null,
    grossMinor: over.grossMinor ?? 10_000_000, discountMinor: over.discountMinor ?? 0,
    manualAdvanceRecoveryMinor: over.manualAdvanceRecoveryMinor ?? null, status: over.status ?? "APPROVED",
  };
}

const status = async (id: number) => (await getCertificate(id))?.status;
const allocated = (certId: number) => rawOne<{ a: number }>(`SELECT COALESCE(SUM(amount_minor),0) AS a FROM payment_certificate_allocations WHERE certificate_id=${certId}`)?.a ?? 0;

describe("Milestone 1 — atomic certificate lifecycle & reconciliation", () => {
  // (1)
  it("promotes a fully allocated approved certificate to PAID", async () => {
    const { contractId } = await makeContract();
    const id = await createCertificate(certInput(contractId, { grossMinor: 10_000_000, status: "APPROVED" }));
    expect(await status(id)).toBe("APPROVED");
    await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-03-01", amountMinor: 10_000_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
      [{ certificateId: id, amountMinor: 10_000_000 }],
    );
    expect(await status(id)).toBe("PAID");
  });

  // (2)
  it("rejects reducing a paid certificate below its allocation, atomically", async () => {
    const { contractId } = await makeContract();
    const id = await createCertificate(certInput(contractId, { grossMinor: 10_000_000, status: "APPROVED" }));
    await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-03-01", amountMinor: 10_000_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
      [{ certificateId: id, amountMinor: 10_000_000 }],
    );
    expect(await status(id)).toBe("PAID");
    await expect(updateCertificate(id, certInput(contractId, { grossMinor: 4_000_000, status: "PAID" }))).rejects.toThrow();
    const after = (await getCertificate(id))!;
    expect(after.status).toBe("PAID");
    expect(after.grossMinor).toBe(10_000_000);
    expect(allocated(id)).toBe(10_000_000);
  });

  // (2b) the allocation-integrity guard across certificates: an earlier-cert
  // change that would strand cash on a later paid certificate is rejected.
  it("rejects an earlier-certificate change that would strand cash on a later paid certificate", async () => {
    const { contractId } = await makeContract({ valueMinor: 100_000_000, advanceMinor: 40_000_000 });
    const a = await createCertificate(certInput(contractId, { number: "PC-A", grossMinor: 80_000_000, status: "SUBMITTED" }));
    const b = await createCertificate(certInput(contractId, { number: "PC-B", grossMinor: 80_000_000, status: "APPROVED" }));
    // B's payable = 80M base − recovery(min(32M, remaining 8M)=8M) = 72M
    await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-B", date: "2026-03-01", amountMinor: 72_000_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
      [{ certificateId: b, amountMinor: 72_000_000 }],
    );
    expect(await status(b)).toBe("PAID");
    // Voiding A frees its 32M of advance to B, dropping B's payable to 48M < 72M
    // collected — rejected atomically, leaving both certificates intact.
    await expect(voidCertificate(a, "test")).rejects.toThrow("ALLOCATION_EXCEEDS_CERTIFICATE_UNPAID");
    expect(await status(a)).toBe("SUBMITTED");
    expect(await status(b)).toBe("PAID");
  });

  // (3)
  it("leaves the certificate and its allocations unchanged when an update is rejected", async () => {
    const { contractId } = await makeContract();
    const id = await createCertificate(certInput(contractId, { grossMinor: 10_000_000, status: "APPROVED" }));
    await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-03-01", amountMinor: 5_000_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
      [{ certificateId: id, amountMinor: 5_000_000 }],
    );
    await expect(updateCertificate(id, certInput(contractId, { grossMinor: 20_000_000, status: "APPROVED" }))).rejects.toThrow("CERTIFICATE_FINANCIALS_IMMUTABLE");
    const after = (await getCertificate(id))!;
    expect(after.grossMinor).toBe(10_000_000);
    expect(after.status).toBe("APPROVED");
    expect(allocated(id)).toBe(5_000_000);
  });

  // (4)
  it("recalculates later certificates' advance recovery when an earlier one is advanced", async () => {
    const { contractId } = await makeContract({ valueMinor: 100_000_000, advanceMinor: 40_000_000 });
    const a = await createCertificate(certInput(contractId, { number: "PC-A", grossMinor: 80_000_000, status: "DRAFT" }));
    const b = await createCertificate(certInput(contractId, { number: "PC-B", grossMinor: 80_000_000, status: "APPROVED" }));
    // A is DRAFT, so it consumes no advance: B recovers its full proportional 32M,
    // payable = 48M. Collect it fully → PAID.
    await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-B", date: "2026-03-01", amountMinor: 48_000_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
      [{ certificateId: b, amountMinor: 48_000_000 }],
    );
    expect(await status(b)).toBe("PAID");
    // Advancing A to SUBMITTED makes it consume 32M of advance first, leaving B
    // only 8M of recovery — B's payable rises to 72M > 48M collected, so B reopens.
    await transitionCertificate(a, "SUBMITTED");
    expect(await status(a)).toBe("SUBMITTED");
    expect(await status(b)).toBe("APPROVED");
  });

  // (5)
  it("reopens a paid certificate when its payment evidence is voided", async () => {
    const { contractId } = await makeContract();
    const id = await createCertificate(certInput(contractId, { grossMinor: 10_000_000, status: "APPROVED" }));
    const pay = await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-03-01", amountMinor: 10_000_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
      [{ certificateId: id, amountMinor: 10_000_000 }],
    );
    expect(await status(id)).toBe("PAID");
    await deletePayment(pay, "reversed");
    expect(await status(id)).toBe("APPROVED");
  });

  // (6)
  it("forbids editing a submitted certificate's financial snapshot but allows admin correction", async () => {
    const { contractId } = await makeContract();
    const id = await createCertificate(certInput(contractId, { grossMinor: 10_000_000, status: "SUBMITTED" }));
    await expect(updateCertificate(id, certInput(contractId, { grossMinor: 12_000_000, status: "SUBMITTED" }))).rejects.toThrow("CERTIFICATE_FINANCIALS_IMMUTABLE");
    // a purely administrative correction is accepted
    await updateCertificate(id, { ...certInput(contractId, { grossMinor: 10_000_000, status: "SUBMITTED" }), description: "corrected note" });
    expect((await getCertificate(id))?.description).toBe("corrected note");
    expect((await getCertificate(id))?.grossMinor).toBe(10_000_000);
  });

  // (7)
  it("forbids editing a paid certificate's financial fields", async () => {
    const { contractId } = await makeContract();
    const id = await createCertificate(certInput(contractId, { grossMinor: 10_000_000, status: "APPROVED" }));
    await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-03-01", amountMinor: 10_000_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
      [{ certificateId: id, amountMinor: 10_000_000 }],
    );
    await expect(updateCertificate(id, certInput(contractId, { grossMinor: 11_000_000, status: "APPROVED" }))).rejects.toThrow("PAID_CERTIFICATE_IMMUTABLE");
  });

  // (8)
  it("never lets a caller assign PAID directly", async () => {
    const { contractId } = await makeContract();
    const id = await createCertificate(certInput(contractId, { grossMinor: 10_000_000, status: "APPROVED" }));
    await expect(setCertificateStatus(id, "PAID")).rejects.toThrow("PAID_REQUIRES_PAYMENT");
    await expect(transitionCertificate(id, "PAID")).rejects.toThrow("PAID_REQUIRES_PAYMENT");
    await expect(createCertificate(certInput(contractId, { number: "PC-Z", status: "PAID" }))).rejects.toThrow("PAID_REQUIRES_PAYMENT");
    expect(await status(id)).toBe("APPROVED");
  });

  // (9)
  it("rejects an allocation that crosses to another contract", async () => {
    const one = await makeContract();
    const two = await makeContract();
    const certTwo = await createCertificate(certInput(two.contractId, { number: "PC-2", grossMinor: 5_000_000, status: "APPROVED" }));
    await expect(createPayment(
      { contractId: one.contractId, kind: "CERTIFICATE", number: "PAY-X", date: "2026-03-01", amountMinor: 1_000_000, method: "CASH", bank: null, reference: null, notes: null },
      [{ certificateId: certTwo, amountMinor: 1_000_000 }],
    )).rejects.toThrow();
    expect(raw("SELECT id FROM payments")).toHaveLength(0);
  });

  // (10)
  it("agrees with the shared engine on certificate financials (Rust parity fixture)", async () => {
    // base = 10,000,000 − 1,000,000 = 9,000,000; VAT 14% = 1,260,000; retention
    // 5% = 450,000; advance PROPORTIONAL 9,000,000 × 20,000,000 / 100,000,000 =
    // 1,800,000; net = 9,000,000 + 1,260,000 − 450,000 − 1,800,000 = 8,010,000.
    // src-tauri/src/lib.rs `certificate_net_payable` is asserted against the same
    // numbers by `cargo test`, so the two engines cannot drift.
    const breakdown = computeCertificate({
      grossMinor: 10_000_000, discountMinor: 1_000_000, vatBp: 1_400, retentionBp: 500, withholdingBp: 0,
      advance: { method: "PROPORTIONAL", contractValueMinor: 100_000_000, advanceMinor: 20_000_000, recoveredBeforeMinor: 0, manualRecoveryMinor: null },
    });
    expect(breakdown.baseMinor).toBe(9_000_000);
    expect(breakdown.advanceRecoveryMinor).toBe(1_800_000);
    expect(breakdown.netPayableMinor).toBe(8_010_000);
  });

  // (11)
  it("assigns a distinct sequence and number to each certificate (concurrency-safe reservation)", async () => {
    const { contractId } = await makeContract();
    const n1 = await reserveNextNumber("CERTIFICATE", "CERT", new Date("2026-02-01T00:00:00Z"));
    const n2 = await reserveNextNumber("CERTIFICATE", "CERT", new Date("2026-02-01T00:00:00Z"));
    expect(n1).not.toBe(n2);
    const a = await createCertificate(certInput(contractId, { number: n1, status: "DRAFT" }));
    const b = await createCertificate(certInput(contractId, { number: n2, status: "DRAFT" }));
    const seqs = raw<{ seq: number; number: string }>(`SELECT seq,number FROM payment_certificates WHERE contract_id=${contractId} ORDER BY seq`);
    expect(seqs.map((r) => r.seq)).toEqual([1, 2]);
    expect(new Set(seqs.map((r) => r.number)).size).toBe(2);
    expect(a).not.toBe(b);
    // the unique (contract_id, number) index also rejects a duplicate number
    await expect(createCertificate(certInput(contractId, { number: n1, status: "DRAFT" }))).rejects.toThrow();
  });

  // (12)
  it("writes only the final committed action to the audit log, and nothing on rollback", async () => {
    const { contractId } = await makeContract();
    const id = await createCertificate(certInput(contractId, { grossMinor: 10_000_000, status: "SUBMITTED" }));
    const created = raw<{ action: string }>(`SELECT action FROM audit_logs WHERE entity_type='payment_certificate' AND entity_id=${id} ORDER BY id`);
    expect(created.map((r) => r.action)).toContain("CREATE");
    const before = rawOne<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs")!.c;
    // a rejected financial edit must leave no audit trace
    await expect(updateCertificate(id, certInput(contractId, { grossMinor: 99_000_000, status: "SUBMITTED" }))).rejects.toThrow("CERTIFICATE_FINANCIALS_IMMUTABLE");
    expect(rawOne<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs")!.c).toBe(before);
  });

  // (13) Audit regression: cross-contract mutation.
  //
  // updateCertificate located the row by id but bound the revision snapshot
  // with the caller's contractId, so a caller could graft a foreign contract's
  // VAT, retention, withholding, advance, payment terms, currency and
  // historical FX onto a certificate that stayed filed under its own contract.
  it("refuses to bind another contract's terms onto a certificate", async () => {
    const own = await makeContract({ vatBp: 0, retentionBp: 0, advanceMinor: 0 });
    const foreign = await makeContract({ vatBp: 1400, retentionBp: 500, advanceMinor: 40_000_000 });
    const id = await createCertificate(certInput(own.contractId, { status: "DRAFT" }));
    const snapshot = () =>
      rawOne<{ contract_id: number; vat_bp_snapshot: number; retention_bp_snapshot: number; advance_minor_snapshot: number }>(
        `SELECT contract_id,vat_bp_snapshot,retention_bp_snapshot,advance_minor_snapshot FROM payment_certificates WHERE id=${id}`,
      )!;
    const before = snapshot();

    await expect(
      updateCertificate(id, { ...certInput(foreign.contractId, { status: "DRAFT" }), grossMinor: 20_000_000 }),
    ).rejects.toThrow("CERTIFICATE_CONTRACT_MISMATCH");

    // The foreign terms did not land, and the edit did not partially apply.
    expect(snapshot()).toEqual(before);
    expect(before.vat_bp_snapshot).toBe(0);
    expect(before.contract_id).toBe(own.contractId);
    expect(rawOne<{ g: number }>(`SELECT gross_minor AS g FROM payment_certificates WHERE id=${id}`)!.g).toBe(10_000_000);
  });

  // (14) Audit regression: archived contracts and projects are read-only.
  //
  // Every certificate read path — the listing, loadContractPayables, the
  // allocation-integrity check, reconciliation — excludes archived contracts
  // and projects. A certificate written against one was therefore invisible:
  // never listed, never reconciled, never covered by the integrity check.
  it("refuses to create a certificate on an archived contract or project", async () => {
    const archivedContract = await makeContract();
    rawExec(`UPDATE contracts SET archived_at=datetime('now') WHERE id=${archivedContract.contractId}`);
    await expect(createCertificate(certInput(archivedContract.contractId, { status: "DRAFT" })))
      .rejects.toThrow("ARCHIVED_CONTRACT_IS_READ_ONLY");
    expect(raw(`SELECT id FROM payment_certificates WHERE contract_id=${archivedContract.contractId}`)).toHaveLength(0);

    const archivedProject = await makeContract();
    rawExec(`UPDATE projects SET archived_at=datetime('now') WHERE id=${archivedProject.projectId}`);
    await expect(createCertificate(certInput(archivedProject.contractId, { status: "DRAFT" })))
      .rejects.toThrow("ARCHIVED_CONTRACT_IS_READ_ONLY");
    expect(raw(`SELECT id FROM payment_certificates WHERE contract_id=${archivedProject.contractId}`)).toHaveLength(0);
  });

  it("refuses to edit, transition or void a certificate under an archived project", async () => {
    const { projectId, contractId } = await makeContract();
    const id = await createCertificate(certInput(contractId, { status: "DRAFT" }));
    rawExec(`UPDATE projects SET archived_at=datetime('now') WHERE id=${projectId}`);

    await expect(updateCertificate(id, certInput(contractId, { grossMinor: 55_000_000, status: "DRAFT" })))
      .rejects.toThrow("ARCHIVED_CONTRACT_IS_READ_ONLY");
    await expect(transitionCertificate(id, "SUBMITTED")).rejects.toThrow("ARCHIVED_CONTRACT_IS_READ_ONLY");
    await expect(voidCertificate(id, "Cleaning up")).rejects.toThrow("ARCHIVED_CONTRACT_IS_READ_ONLY");

    // The certificate is exactly as it was: no amount, status or void applied.
    const row = rawOne<{ gross_minor: number; status: string; voided_at: string | null }>(
      `SELECT gross_minor,status,voided_at FROM payment_certificates WHERE id=${id}`,
    )!;
    expect(row).toEqual({ gross_minor: 10_000_000, status: "DRAFT", voided_at: null });
  });
});
