import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { raw, rawExec, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject, updateProject } from "../src/repositories/projects";
import { createContract, listContractRevisions, updateContract } from "../src/repositories/contracts";
import { createCertificate, getCertificate, setCertificateStatus } from "../src/repositories/certificates";
import { loadWorkspaceFinancials } from "../src/repositories/financials";
import type { ContractInput } from "@mep/core";

beforeEach(() => resetDb());

async function fixture() {
  const clientId = await createClient({ name: "Revision Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject("PRJ-REV-001", { name: "Revision Project", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
  const terms: ContractInput = { projectId, number: "REV-C1", title: null, valueMinor: 1_000_000, vatBp: 1_400, retentionBp: 500, withholdingBp: 0, advanceMinor: 100_000, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: "2026-01-01", notes: null };
  const contractId = await createContract(terms);
  return { contractId, projectId, terms };
}

describe("Milestone 4 contract revisions", () => {
  it("creates revision 1 atomically with a new contract", async () => {
    const { contractId } = await fixture();
    const revisions = await listContractRevisions(contractId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revisionNumber: 1, vatBp: 1_400, contractValueMinor: 1_000_000 });
  });

  it("preserves an approved certificate when VAT and retention change", async () => {
    const { contractId, terms } = await fixture();
    const oldId = await createCertificate(1, { contractId, number: "PC-OLD", date: "2026-01-15", submissionDate: "2026-01-15", dueDateOverride: null, description: null, grossMinor: 200_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    const before = (await loadWorkspaceFinancials()).contractStates.get(contractId)!.certificates.find((c) => c.certificate.id === oldId)!.breakdown;

    const revised = { ...terms, valueMinor: 1_200_000, vatBp: 1_500, retentionBp: 750 };
    await updateContract(contractId, revised, { effectiveDate: "2026-02-01", reason: "Approved variation and tax update" });
    const after = (await loadWorkspaceFinancials()).contractStates.get(contractId)!.certificates.find((c) => c.certificate.id === oldId)!.breakdown;
    expect(after).toEqual(before);

    const newId = await createCertificate(2, { contractId, number: "PC-NEW", date: "2026-03-01", submissionDate: "2026-03-01", dueDateOverride: null, description: null, grossMinor: 200_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    const next = (await loadWorkspaceFinancials()).contractStates.get(contractId)!.certificates.find((c) => c.certificate.id === newId)!;
    expect(next.certificate.vatBpSnapshot).toBe(1_500);
    expect(next.certificate.retentionBpSnapshot).toBe(750);
    expect(next.breakdown.vatMinor).toBe(30_000);
    expect(await listContractRevisions(contractId)).toHaveLength(2);
    expect(raw("SELECT value_delta_minor FROM variation_orders")).toEqual([{ value_delta_minor: 200_000 }]);
  });

  it("rejects protected edits after submission without revision metadata", async () => {
    const { contractId, terms } = await fixture();
    await createCertificate(1, { contractId, number: "PC-1", date: "2026-01-15", submissionDate: "2026-01-15", dueDateOverride: null, description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "SUBMITTED" });
    await expect(updateContract(contractId, { ...terms, vatBp: 2_000 })).rejects.toThrow("CONTRACT_REVISION_REQUIRED");
    expect(await listContractRevisions(contractId)).toHaveLength(1);
  });

  it("rolls back the contract edit when revision creation fails", async () => {
    const { contractId, terms } = await fixture();
    await createCertificate(1, { contractId, number: "PC-1", date: "2026-01-15", submissionDate: "2026-01-15", dueDateOverride: null, description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    rawExec("CREATE TRIGGER fail_revision BEFORE INSERT ON contract_revisions BEGIN SELECT RAISE(ABORT, 'injected revision failure'); END;");

    await expect(updateContract(contractId, { ...terms, vatBp: 2_000 }, { effectiveDate: "2026-02-01", reason: "test" })).rejects.toThrow();

    expect(raw<{ vat_bp: number }>(`SELECT vat_bp FROM contracts WHERE id=${contractId}`)[0]?.vat_bp).toBe(1_400);
    expect(await listContractRevisions(contractId)).toHaveLength(1);
  });

  it("does not submit a draft when an approved revision cannot be snapshotted", async () => {
    const { contractId } = await fixture();
    const certificateId = await createCertificate(1, { contractId, number: "PC-DRAFT", date: "2026-01-15", submissionDate: null, dueDateOverride: null, description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "DRAFT" });
    rawExec("DROP TRIGGER prevent_approved_contract_revision_edit");
    rawExec(`UPDATE contract_revisions SET approved_at=NULL WHERE contract_id=${contractId}`);

    await expect(setCertificateStatus(certificateId, "SUBMITTED", "2026-01-16")).rejects.toThrow("CERTIFICATE_REVISION_BIND_FAILED");

    expect(await getCertificate(certificateId)).toMatchObject({ status: "DRAFT", submissionDate: null });
  });

  it("requires and persists explicit confirmation when quick submission follows an earlier due override", async () => {
    const { contractId } = await fixture();
    const certificateId = await createCertificate(1, { contractId, number: "PC-DUE", date: "2026-01-15", submissionDate: null, dueDateOverride: "2026-01-14", description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "DRAFT" });

    await expect(setCertificateStatus(certificateId, "SUBMITTED", "2026-01-16")).rejects.toThrow("DUE_BEFORE_SUBMISSION_CONFIRMATION_REQUIRED");
    expect(await getCertificate(certificateId)).toMatchObject({ status: "DRAFT", submissionDate: null });

    await setCertificateStatus(certificateId, "SUBMITTED", "2026-01-16", true);
    expect(await getCertificate(certificateId)).toMatchObject({ status: "SUBMITTED", submissionDate: "2026-01-16" });
    expect(raw<{ due_date_confirmed_at: string | null }>(`SELECT due_date_confirmed_at FROM payment_certificates WHERE id=${certificateId}`)[0]?.due_date_confirmed_at).toBeTruthy();
  });

  it("never applies a future-dated revision to an earlier certificate", async () => {
    const { contractId, terms } = await fixture();
    await createCertificate(1, { contractId, number: "PC-1", date: "2026-02-01", submissionDate: "2026-02-01", dueDateOverride: null, description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "SUBMITTED" });
    await updateContract(contractId, { ...terms, vatBp: 2_000 }, { effectiveDate: "2026-07-01", reason: "Future tax terms" });

    const certificateId = await createCertificate(2, { contractId, number: "PC-2", date: "2026-06-01", submissionDate: "2026-06-01", dueDateOverride: null, description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });

    expect(await getCertificate(certificateId)).toMatchObject({ contractRevisionId: 1, vatBpSnapshot: 1_400 });
  });

  it("prevents approved revision and variation-order terms from being rewritten", async () => {
    const { contractId, terms } = await fixture();
    await createCertificate(1, { contractId, number: "PC-1", date: "2026-02-01", submissionDate: "2026-02-01", dueDateOverride: null, description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    await updateContract(contractId, { ...terms, valueMinor: 1_100_000 }, { effectiveDate: "2026-03-01", reason: "Approved variation" });

    expect(() => rawExec("UPDATE contract_revisions SET vat_bp=999 WHERE revision_number=2")).toThrow("APPROVED_CONTRACT_REVISION_IMMUTABLE");
    expect(() => rawExec("UPDATE variation_orders SET value_delta_minor=1")).toThrow("APPROVED_VARIATION_ORDER_IMMUTABLE");
  });

  it("creates traceable revisions for project currency and exchange-rate changes", async () => {
    const { contractId, projectId } = await fixture();
    const oldId = await createCertificate(1, { contractId, number: "PC-OLD", date: "2026-02-01", submissionDate: "2026-02-01", dueDateOverride: null, description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
    await updateProject(projectId, { name: "Revision Project", clientId: 1, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "USD", fxRateMicro: 50_000_000, startDate: null, endDate: null, progressBp: 0, description: null }, { effectiveDate: "2026-03-01", reason: "Contract converted to USD" });
    const newId = await createCertificate(2, { contractId, number: "PC-NEW", date: "2026-04-01", submissionDate: "2026-04-01", dueDateOverride: null, description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });

    expect(await getCertificate(oldId)).toMatchObject({ currencySnapshot: "EGP", fxRateMicroSnapshot: 1_000_000 });
    expect(await getCertificate(newId)).toMatchObject({ currencySnapshot: "USD", fxRateMicroSnapshot: 50_000_000 });
    expect(await listContractRevisions(contractId)).toHaveLength(2);
  });

  it("rejects a submitted certificate whose snapshot does not match its revision", async () => {
    const { contractId } = await fixture();
    const certificateId = await createCertificate(1, { contractId, number: "PC-TAMPER", date: "2026-02-01", submissionDate: null, dueDateOverride: null, description: null, grossMinor: 100_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "DRAFT" });
    rawExec(`UPDATE payment_certificates SET vat_bp_snapshot=999 WHERE id=${certificateId}`);

    expect(() => rawExec(`UPDATE payment_certificates SET status='SUBMITTED' WHERE id=${certificateId}`)).toThrow("CERTIFICATE_SNAPSHOT_REVISION_MISMATCH");
    expect(await getCertificate(certificateId)).toMatchObject({ status: "DRAFT", vatBpSnapshot: 999 });
  });

  it("rolls back a project FX edit when any contract revision fails", async () => {
    const { contractId, projectId } = await fixture();
    rawExec("CREATE TRIGGER fail_project_fx_revision BEFORE INSERT ON contract_revisions BEGIN SELECT RAISE(ABORT, 'injected FX revision failure'); END;");

    await expect(updateProject(projectId, { name: "Revision Project", clientId: 1, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "USD", fxRateMicro: 50_000_000, startDate: null, endDate: null, progressBp: 0, description: null }, { effectiveDate: "2026-03-01", reason: "FX change" })).rejects.toThrow();

    expect(raw<{ currency: string; fx_rate_micro: number }>(`SELECT currency,fx_rate_micro FROM projects WHERE id=${projectId}`)[0]).toEqual({ currency: "EGP", fx_rate_micro: 1_000_000 });
    expect(await listContractRevisions(contractId)).toHaveLength(1);
  });
});
