import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { execute } from "./db-harness";
import { raw, rawExec, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createCertificate, setCertificateStatus } from "../src/repositories/certificates";
import { createPayment, deletePayment, updatePayment } from "../src/repositories/payments";
import { finalizePendingRestoreAudit, listAuditRecords, listEntityHistory } from "../src/repositories/audit";

beforeEach(() => resetDb());

async function fixture() {
  const clientId = await createClient({ name: "Audit Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject("AUD-2026-001", { name: "Audit Project", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
  const contractId = await createContract({ projectId, number: "AUD-C-1", title: "Audit", valueMinor: 1_000_000, vatBp: 1_400, retentionBp: 500, withholdingBp: 100, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "MILESTONES", milestones: null, drawings: null, attachments: null, signedDate: "2026-01-01", notes: null });
  const certificateId = await createCertificate(1, { contractId, number: "AUD-PC-1", date: "2026-01-02", submissionDate: null, dueDateOverride: null, description: "Audit certificate", grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "DRAFT" });
  await setCertificateStatus(certificateId, "APPROVED", "2026-01-03");
  return { contractId, certificateId };
}

describe("Milestone 8 immutable audit trail", () => {
  it("records payment, allocation, edits, status effects and voiding as one history", async () => {
    const { contractId, certificateId } = await fixture();
    const paymentId = await createPayment({ contractId, kind: "CERTIFICATE", number: "PAY-AUD", date: "2026-01-04", amountMinor: 50_000, method: "BANK_TRANSFER", bank: "SECRET BANK", reference: "SECRET REF", notes: "SECRET NOTE" }, [{ certificateId, amountMinor: 50_000 }]);
    await updatePayment(paymentId, { contractId, kind: "CERTIFICATE", number: "PAY-AUD-EDIT", date: "2026-01-04", amountMinor: 60_000, method: "BANK_TRANSFER", bank: "NEW SECRET", reference: "NEW REF", notes: "NEW NOTE" }, [{ certificateId, amountMinor: 60_000 }]);
    await deletePayment(paymentId);

    const paymentHistory = await listEntityHistory("payment", paymentId, null);
    expect(paymentHistory.map((row) => row.action)).toEqual(["CREATE", "UPDATE", "VOID"]);
    expect(paymentHistory.map((row) => `${row.beforeJson}${row.afterJson}`).join(" ")).not.toContain("SECRET");
    expect(paymentHistory[0]?.afterJson).toContain("[REDACTED]");
    const allocations = await listAuditRecords({ entityType: "payment_allocation" });
    expect(allocations.map((row) => row.action)).toEqual(expect.arrayContaining(["ALLOCATION_ADD", "ALLOCATION_REMOVE"]));
  });

  it("rolls audit rows back with a failed financial transaction", async () => {
    const { contractId, certificateId } = await fixture();
    const before = raw<{ count: number }>("SELECT COUNT(*) AS count FROM audit_logs")[0]!.count;
    rawExec("CREATE TRIGGER fail_audited_allocation BEFORE INSERT ON payment_certificate_allocations BEGIN SELECT RAISE(ABORT,'injected'); END;");
    await expect(createPayment({ contractId, kind: "CERTIFICATE", number: "FAIL", date: "2026-01-04", amountMinor: 10_000, method: "CASH", bank: null, reference: null, notes: null }, [{ certificateId, amountMinor: 10_000 }])).rejects.toThrow();
    expect(raw<{ count: number }>("SELECT COUNT(*) AS count FROM audit_logs")[0]!.count).toBe(before);
    expect(raw("SELECT id FROM payments WHERE number='FAIL'")).toHaveLength(0);
  });

  it("rejects normal updates and deletes of audit history", async () => {
    await fixture();
    const id = raw<{ id: number }>("SELECT id FROM audit_logs ORDER BY id LIMIT 1")[0]!.id;
    await expect(execute("UPDATE audit_logs SET action='TAMPER' WHERE id=$1", [id])).rejects.toThrow("AUDIT_LOG_IMMUTABLE");
    await expect(execute("DELETE FROM audit_logs WHERE id=$1", [id])).rejects.toThrow("AUDIT_LOG_IMMUTABLE");
  });

  it("supports date, entity, user and action filters", async () => {
    await execute("INSERT INTO settings(key,value) VALUES('sync_email','auditor@namaa.local') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    await execute("UPDATE settings SET value='11111111-2222-4333-8444-555555555555' WHERE key='sync_user_id'");
    await fixture();
    const rows = await listAuditRecords({ dateFrom: "2020-01-01", dateTo: "2099-12-31", entityType: "payment_certificate", userId: "11111111-2222-4333-8444-555555555555", action: "STATUS_CHANGE" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "payment_certificate", action: "STATUS_CHANGE", userId: "11111111-2222-4333-8444-555555555555" });
    expect(rows[0]?.beforeJson).toContain('"status":"DRAFT"');
    expect(rows[0]?.afterJson).toContain('"status":"APPROVED"');
  });

  it("keeps UUID-only timelines isolated and records the running app version", async () => {
    await execute("UPDATE currencies SET fx_rate_micro=37000000 WHERE code='USD'");
    await execute("UPDATE currencies SET fx_rate_micro=13000000 WHERE code='SAR'");
    const usd = await listEntityHistory("currency", null, "USD");
    expect(usd).toHaveLength(1);
    expect(usd[0]?.entityUuid).toBe("USD");
    expect(usd[0]?.applicationVersion).toBe("0.6.3");
  });

  it("retains cross-device UUID identity for newly audited synced entities", async () => {
    const { contractId } = await fixture();
    const row = raw<{ entity_uuid: string | null }>(`SELECT entity_uuid FROM audit_logs WHERE entity_type='contract' AND entity_id=${contractId} AND action='CREATE'`)[0];
    expect(row?.entity_uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows delivery milestones and certificate collection dates in before/after evidence", async () => {
    const { contractId, certificateId } = await fixture();
    const original = JSON.stringify([{ title: "Design", percentBp: 10_000, done: false }]);
    const achieved = JSON.stringify([{ title: "Design", percentBp: 10_000, done: true }]);
    await execute("UPDATE contracts SET milestones=$1 WHERE id=$2", [original, contractId]);
    await execute("UPDATE contracts SET milestones=$1 WHERE id=$2", [achieved, contractId]);
    await execute("UPDATE payment_certificates SET due_date_override='2026-02-15' WHERE id=$1", [certificateId]);

    const contractHistory = await listEntityHistory("contract", contractId, null);
    const milestoneChange = contractHistory.at(-1)!;
    expect(milestoneChange.beforeJson).toContain('"done":false');
    expect(milestoneChange.afterJson).toContain('"done":true');
    const certificateHistory = await listEntityHistory("payment_certificate", certificateId, null);
    expect(certificateHistory.at(-1)?.afterJson).toContain('"dueDateOverride":"2026-02-15"');
  });

  it("does not let malformed legacy milestone JSON block an otherwise valid financial update", async () => {
    const { contractId } = await fixture();
    await execute("UPDATE contracts SET milestones='' WHERE id=$1", [contractId]);
    await expect(execute("UPDATE contracts SET performance_bond_bp=250 WHERE id=$1", [contractId])).resolves.toBeDefined();
    const history = await listEntityHistory("contract", contractId, null);
    expect(history.at(-1)?.afterJson).toContain('"performanceBondBp":250');
  });

  it("converts a pre-audit restore marker atomically with RESTORE attribution", async () => {
    await execute("INSERT INTO settings(key,value) VALUES('pending_restore_audit','1')");
    await finalizePendingRestoreAudit();
    expect(raw("SELECT key FROM settings WHERE key='pending_restore_audit'")).toHaveLength(0);
    expect(raw<{ action: string; source: string; application_version: string }>("SELECT action,source,application_version FROM audit_logs WHERE action='RESTORE'")).toEqual([
      { action: "RESTORE", source: "RESTORE", application_version: "0.6.3" },
    ]);
  });
});
