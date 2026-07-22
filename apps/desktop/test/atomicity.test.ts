import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { raw, rawExec, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createPerson, createAssignment, createPersonPayment, deletePersonPayment } from "../src/repositories/people";
import { reconcileMilestoneCertificates } from "../src/repositories/milestoneCertificates";
import { createDocument } from "../src/repositories/documents";

beforeEach(() => resetDb());

async function projectFixture(code = "PRJ-2026-ATOMIC") {
  const clientId = await createClient({ name: code, company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject(code, { name: code, clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
  return { clientId, projectId };
}

describe("Milestone 2 transaction boundaries", () => {
  it("rolls back document metadata when device-cache registration fails",async()=>{
    const {projectId}=await projectFixture("PRJ-2026-DOC-ATOMIC");
    rawExec("CREATE TRIGGER fail_document_cache BEFORE INSERT ON document_cache BEGIN SELECT RAISE(ABORT,'injected cache failure'); END;");
    await expect(createDocument({projectId,category:"OTHER",title:"legacy.pdf",path:"C:/legacy.pdf"})).rejects.toThrow();
    expect(raw("SELECT id FROM documents")).toHaveLength(0);
  });
  it("rolls back person payment when linked expense creation fails", async () => {
    const { projectId } = await projectFixture();
    const personId = await createPerson({ type: "FREELANCER", name: "Atomic Person", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const assignmentId = await createAssignment({ personId, projectId, agreedMinor: 20_000, currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null });
    rawExec("CREATE TRIGGER fail_linked_expense BEFORE INSERT ON expenses BEGIN SELECT RAISE(ABORT, 'injected expense failure'); END;");

    await expect(createPersonPayment({ assignmentId, date: "2026-07-21", amountMinor: 5_000, note: "test" })).rejects.toThrow();

    expect(raw("SELECT id FROM person_payments")).toHaveLength(0);
    expect(raw("SELECT id FROM expenses WHERE person_payment_id IS NOT NULL")).toHaveLength(0);
  });

  it("rolls back person payment when no expense category exists", async () => {
    const { projectId } = await projectFixture("PRJ-2026-NOCATEGORY");
    const personId = await createPerson({ type: "FREELANCER", name: "No Category", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const assignmentId = await createAssignment({ personId, projectId, agreedMinor: 20_000, currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null });
    rawExec("DELETE FROM expense_categories");

    await expect(createPersonPayment({ assignmentId, date: "2026-07-21", amountMinor: 5_000, note: "test" })).rejects.toThrow("EXPENSE_CATEGORY_NOT_FOUND");

    expect(raw("SELECT id FROM person_payments")).toHaveLength(0);
    expect(raw("SELECT id FROM expenses WHERE person_payment_id IS NOT NULL")).toHaveLength(0);
  });

  it("rejects reversing a missing person payment without changing expenses", async () => {
    const before = raw<{ count: number }>("SELECT COUNT(*) AS count FROM expenses")[0]?.count;
    await expect(deletePersonPayment(999_999)).rejects.toThrow("PERSON_PAYMENT_NOT_FOUND");
    expect(raw<{ count: number }>("SELECT COUNT(*) AS count FROM expenses")[0]?.count).toBe(before);
  });

  it("rolls back generated certificates when milestone linkage update fails", async () => {
    const { projectId } = await projectFixture("PRJ-2026-MILESTONE");
    const milestones = [{ title: "Concept", percentBp: 10_000, stageId: null, done: true, certificateId: null }];
    const contractId = await createContract({ projectId, number: "C-ATOMIC", title: null, valueMinor: 100_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "MILESTONES", milestones: JSON.stringify(milestones), drawings: null, attachments: null, signedDate: null, notes: null });
    rawExec("CREATE TRIGGER fail_milestone_link BEFORE UPDATE OF milestones ON contracts BEGIN SELECT RAISE(ABORT, 'injected milestone failure'); END;");

    await expect(reconcileMilestoneCertificates(contractId)).rejects.toThrow();

    expect(raw(`SELECT id FROM payment_certificates WHERE contract_id=${contractId}`)).toHaveLength(0);
    expect(raw<{ milestones: string }>(`SELECT milestones FROM contracts WHERE id=${contractId}`)[0]?.milestones).toBe(JSON.stringify(milestones));
  });

  it("the unique project-code constraint rejects a concurrent duplicate without partial rows", async () => {
    const first = await projectFixture("PRJ-2026-RACE");
    await expect(createProject("PRJ-2026-RACE", { name: "Duplicate", clientId: first.clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null })).rejects.toThrow();
    expect(raw("SELECT id FROM projects WHERE code='PRJ-2026-RACE'")).toHaveLength(1);
  });
});
