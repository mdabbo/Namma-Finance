import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

// Back the app's real repositories with the migration-built SQLite harness
// (same pattern as smoke.test.ts / simulation.test.ts) so every assertion
// here exercises production SQL, triggers and FK cascades — not a mock.
vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { resetDb, raw, rawOne } from "./db-harness";
import { createClient, updateClient, deleteClient, clientCascadeInfo, getClient } from "../src/repositories/clients";
import { createProject, updateProject, deleteProject, projectCascadeInfo, getProject } from "../src/repositories/projects";
import { createContract, updateContract, deleteContract, contractCascadeInfo, getContract } from "../src/repositories/contracts";
import { createCertificate, updateCertificate, deleteCertificate, nextCertificateSeq, getCertificate, listCertificates } from "../src/repositories/certificates";
import { createPayment, updatePayment, deletePayment, getPayment, listPayments, listAllocationsByPayment } from "../src/repositories/payments";
import { createExpense, updateExpense, deleteExpense, createCategory, updateCategory, deleteCategory, listCategories, listExpenses } from "../src/repositories/expenses";
import { createPerson, updatePerson, deletePerson, getPerson, createAssignment, updateAssignment, deleteAssignment, createPersonPayment, deletePersonPayment, listAssignmentsByPerson, listPersonPayments } from "../src/repositories/people";
import { createStage, updateStage, deleteStage, listStagesByProject } from "../src/repositories/stages";
import { createDocument, updateDocument, deleteDocument, listDocumentsByProject } from "../src/repositories/documents";
import { createRecurring, updateRecurring, deleteRecurring, listRecurring } from "../src/repositories/recurring";
import { createTimeEntry, updateTimeEntry, deleteTimeEntry, listTimeEntries } from "../src/repositories/timeEntries";
import type { ClientInput, ContractInput, ProjectInput } from "@mep/core";

beforeEach(() => resetDb());

// ─── shared fixtures ─────────────────────────────────────────────────────

function client(over: Partial<ClientInput> = {}): ClientInput {
  return { name: "Client A", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null, ...over };
}

function project(clientId: number, over: Partial<ProjectInput> = {}): ProjectInput {
  return {
    name: "Project A", clientId, country: null, city: null, manager: null, discipline: "MULTI",
    projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000,
    startDate: null, endDate: null, progressBp: 0, description: null, ...over,
  };
}

function contract(projectId: number, over: Partial<ContractInput> = {}): ContractInput {
  return {
    projectId, number: "C-900", title: null, valueMinor: 100_000_000, vatBp: 1400, retentionBp: 500,
    withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
    performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
    valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null,
    ...over,
  };
}

async function firstCategoryId(): Promise<number> {
  return (await listCategories())[0]!.id;
}

// ─── EDIT: persistence for every module ─────────────────────────────────

describe("edit persists correctly", () => {
  it("client", async () => {
    const id = await createClient(client());
    await updateClient(id, client({ name: "Client A Renamed", email: "a@b.com" }));
    const got = await getClient(id);
    expect(got).toMatchObject({ name: "Client A Renamed", email: "a@b.com" });
  });

  it("project", async () => {
    const clientId = await createClient(client());
    const id = await createProject("PRJ-2026-900", project(clientId));
    await updateProject(id, project(clientId, { name: "Renamed", status: "ON_HOLD", progressBp: 5000 }));
    const got = await getProject(id);
    expect(got).toMatchObject({ name: "Renamed", status: "ON_HOLD", progressBp: 5000 });
  });

  it("contract", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-901", project(clientId));
    const id = await createContract(contract(projectId));
    await updateContract(id, contract(projectId, { valueMinor: 200_000_000, vatBp: 1000 }));
    const got = await getContract(id);
    expect(got).toMatchObject({ valueMinor: 200_000_000, vatBp: 1000 });
  });

  it("certificate", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-902", project(clientId));
    const contractId = await createContract(contract(projectId));
    const seq = await nextCertificateSeq(contractId);
    const id = await createCertificate(seq, {
      contractId, number: "PC-1", date: "2026-07-01", submissionDate: null, dueDateOverride: null,
      description: null, grossMinor: 10_000_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "DRAFT",
    });
    await updateCertificate(id, {
      contractId, number: "PC-1", date: "2026-07-01", submissionDate: null, dueDateOverride: null,
      description: "revised", grossMinor: 15_000_000, discountMinor: 500_000, manualAdvanceRecoveryMinor: null, status: "SUBMITTED",
    });
    const got = await getCertificate(id);
    expect(got).toMatchObject({ grossMinor: 15_000_000, discountMinor: 500_000, status: "SUBMITTED", description: "revised" });
  });

  it("payment (including reallocation)", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-903", project(clientId));
    const contractId = await createContract(contract(projectId));
    const seq = await nextCertificateSeq(contractId);
    const certId = await createCertificate(seq, {
      contractId, number: "PC-1", date: "2026-07-01", submissionDate: null, dueDateOverride: null,
      description: null, grossMinor: 10_000_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED",
    });
    const payId = await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-07-05", amountMinor: 1_000_000, method: "CASH", bank: null, reference: null, notes: null },
      [{ certificateId: certId, amountMinor: 1_000_000 }],
    );
    await updatePayment(
      payId,
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-07-06", amountMinor: 2_000_000, method: "BANK_TRANSFER", bank: "NBE", reference: "REF1", notes: null },
      [{ certificateId: certId, amountMinor: 2_000_000 }],
    );
    const got = await getPayment(payId);
    expect(got).toMatchObject({ amountMinor: 2_000_000, method: "BANK_TRANSFER", bank: "NBE" });
    const allocs = await listAllocationsByPayment(payId);
    expect(allocs).toEqual([expect.objectContaining({ certificateId: certId, amountMinor: 2_000_000 })]);
  });

  it("expense", async () => {
    const catId = await firstCategoryId();
    const id = await createExpense({ date: "2026-07-01", categoryId: catId, description: "Printing", projectId: null, supplier: null, amountMinor: 5_000_00, currency: "EGP", fxRateMicro: 1_000_000, attachmentPath: null });
    await updateExpense(id, { date: "2026-07-02", categoryId: catId, description: "Printing revised", projectId: null, supplier: "ACME", amountMinor: 7_500_00, currency: "EGP", fxRateMicro: 1_000_000, attachmentPath: null });
    const got = (await listExpenses()).find((e) => e.id === id);
    expect(got).toMatchObject({ description: "Printing revised", supplier: "ACME", amountMinor: 7_500_00 });
  });

  it("expense category", async () => {
    await createCategory("Fuel", "وقود");
    const cat = (await listCategories()).find((c) => c.nameEn === "Fuel")!;
    await updateCategory(cat.id, "Fuel & Transport", "وقود ونقل", false);
    const got = (await listCategories(true)).find((c) => c.id === cat.id);
    expect(got).toMatchObject({ nameEn: "Fuel & Transport", nameAr: "وقود ونقل", isActive: false });
  });

  it("person", async () => {
    const id = await createPerson({ type: "FREELANCER", name: "Eng A", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    await updatePerson(id, { type: "FREELANCER", name: "Eng A", specialization: "MEP", phone: null, email: null, bankAccount: null, hourlyRateMinor: 10_000, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const got = await getPerson(id);
    expect(got).toMatchObject({ specialization: "MEP", hourlyRateMinor: 10_000 });
  });

  it("project assignment", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-904", project(clientId));
    const personId = await createPerson({ type: "FREELANCER", name: "Eng B", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const id = await createAssignment({ personId, projectId, agreedMinor: 50_000_00, currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null });
    await updateAssignment(id, { personId, projectId, agreedMinor: 75_000_00, currency: "EGP", fxRateMicro: 1_000_000, scope: "Design only", progressNote: "50% done" });
    const got = (await listAssignmentsByPerson(personId)).find((a) => a.id === id);
    expect(got).toMatchObject({ agreedMinor: 75_000_00, scope: "Design only", progressNote: "50% done" });
  });

  it("project stage", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-905", project(clientId));
    const id = await createStage({ projectId, name: "Concept", sortOrder: 0, startDate: null, endDate: null, status: "PLANNED", completionBp: 0, engineers: null, notes: null });
    await updateStage(id, { projectId, name: "Concept", sortOrder: 0, startDate: "2026-07-01", endDate: "2026-07-15", status: "IN_PROGRESS", completionBp: 4000, engineers: "Eng A, Eng B", notes: null });
    const got = (await listStagesByProject(projectId)).find((s) => s.id === id);
    expect(got).toMatchObject({ status: "IN_PROGRESS", completionBp: 4000, engineers: "Eng A, Eng B" });
  });

  it("document", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-906", project(clientId));
    const id = await createDocument({ projectId, category: "OTHER", title: "Draft.pdf", path: "C:\\draft.pdf" });
    await updateDocument(id, "CONTRACT", "Signed Contract.pdf");
    const got = (await listDocumentsByProject(projectId)).find((d) => d.id === id);
    expect(got).toMatchObject({ category: "CONTRACT", title: "Signed Contract.pdf" });
  });

  it("recurring expense", async () => {
    const catId = await firstCategoryId();
    const id = await createRecurring({ name: "Rent", categoryId: catId, amountMinor: 10_000_00, currency: "EGP", fxRateMicro: 1_000_000, dayOfMonth: 1, isActive: true, notes: null });
    await updateRecurring(id, { name: "Office Rent", categoryId: catId, amountMinor: 12_000_00, currency: "EGP", fxRateMicro: 1_000_000, dayOfMonth: 5, isActive: false, notes: "raised" });
    const got = (await listRecurring()).find((r) => r.id === id);
    expect(got).toMatchObject({ name: "Office Rent", amountMinor: 12_000_00, dayOfMonth: 5, isActive: false });
  });

  it("time entry", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-907", project(clientId));
    const personId = await createPerson({ type: "EMPLOYEE", name: "Eng C", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: 5_000, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const id = await createTimeEntry({ personId, projectId, stageId: null, date: "2026-07-01", minutes: 60, billable: true, note: null });
    await updateTimeEntry(id, { personId, projectId, stageId: null, date: "2026-07-02", minutes: 180, billable: false, note: "revised" });
    const got = (await listTimeEntries()).find((e) => e.id === id);
    expect(got).toMatchObject({ date: "2026-07-02", minutes: 180, billable: false, note: "revised" });
  });
});

// ─── DELETE: soft-delete modules ────────────────────────────────────────

describe("delete: soft-delete modules keep history", () => {
  it("certificate is excluded from listings but the row survives", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-910", project(clientId));
    const contractId = await createContract(contract(projectId));
    const seq = await nextCertificateSeq(contractId);
    const id = await createCertificate(seq, {
      contractId, number: "PC-1", date: "2026-07-01", submissionDate: null, dueDateOverride: null,
      description: null, grossMinor: 10_000_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "DRAFT",
    });
    await deleteCertificate(id);
    expect(await listCertificates()).toHaveLength(0);
    const row = rawOne<{ deleted_at: string | null }>(`SELECT deleted_at FROM payment_certificates WHERE id=${id}`);
    expect(row?.deleted_at).toBeTruthy();
  });

  it("payment is excluded from listings but its allocations survive for audit", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-911", project(clientId));
    const contractId = await createContract(contract(projectId));
    const seq = await nextCertificateSeq(contractId);
    const certId = await createCertificate(seq, {
      contractId, number: "PC-1", date: "2026-07-01", submissionDate: null, dueDateOverride: null,
      description: null, grossMinor: 10_000_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED",
    });
    const payId = await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-07-05", amountMinor: 1_000_000, method: "CASH", bank: null, reference: null, notes: null },
      [{ certificateId: certId, amountMinor: 1_000_000 }],
    );
    await deletePayment(payId);
    expect(await listPayments()).toHaveLength(0);
    const row = rawOne<{ deleted_at: string | null }>(`SELECT deleted_at FROM payments WHERE id=${payId}`);
    expect(row?.deleted_at).toBeTruthy();
    // allocation row is untouched — financials.ts excludes it by joining on live payments, not by deleting it
    expect(raw(`SELECT id FROM payment_certificate_allocations WHERE payment_id=${payId}`)).toHaveLength(1);
  });
});

// ─── DELETE: RESTRICT guard ──────────────────────────────────────────────

describe("delete: expense category RESTRICT guard", () => {
  it("refuses to delete a category in use, then succeeds once the expense is gone", async () => {
    await createCategory("Fuel", "وقود");
    const cat = (await listCategories()).find((c) => c.nameEn === "Fuel")!;
    const expId = await createExpense({ date: "2026-07-01", categoryId: cat.id, description: "Diesel", projectId: null, supplier: null, amountMinor: 1_000_00, currency: "EGP", fxRateMicro: 1_000_000, attachmentPath: null });

    const blocked = await deleteCategory(cat.id);
    expect(blocked).toEqual({ ok: false });
    expect((await listCategories(true)).some((c) => c.id === cat.id)).toBe(true);

    await deleteExpense(expId);
    const freed = await deleteCategory(cat.id);
    expect(freed).toEqual({ ok: true });
    expect((await listCategories(true)).some((c) => c.id === cat.id)).toBe(false);
  });
});

// ─── DELETE: SET NULL ────────────────────────────────────────────────────

describe("delete: stage removal detaches (not deletes) its time entries", () => {
  it("time entry survives with stage_id = NULL", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-912", project(clientId));
    const personId = await createPerson({ type: "EMPLOYEE", name: "Eng D", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const stageId = await createStage({ projectId, name: "Concept", sortOrder: 0, startDate: null, endDate: null, status: "PLANNED", completionBp: 0, engineers: null, notes: null });
    const entryId = await createTimeEntry({ personId, projectId, stageId, date: "2026-07-01", minutes: 60, billable: true, note: null });

    await deleteStage(stageId);

    const entries = await listTimeEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: entryId, stageId: null });
  });
});

// ─── DELETE: person payment auto-expense cleanup ────────────────────────

describe("delete: removing a person payment removes its auto-created expense", () => {
  it("linked expense disappears via FK cascade", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-913", project(clientId));
    const personId = await createPerson({ type: "FREELANCER", name: "Eng E", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const assignmentId = await createAssignment({ personId, projectId, agreedMinor: 50_000_00, currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null });
    const paymentId = await createPersonPayment({ assignmentId, date: "2026-07-10", amountMinor: 20_000_00, note: null });

    expect((await listExpenses()).filter((e) => e.personPaymentId === paymentId)).toHaveLength(1);

    await deletePersonPayment(paymentId);

    expect((await listPersonPayments([assignmentId]))).toHaveLength(0);
    expect((await listExpenses()).filter((e) => e.personPaymentId === paymentId)).toHaveLength(0);
  });
});

// ─── DELETE: cascade info helpers report correct pre-delete counts ──────

describe("cascade-info helpers match what will actually be destroyed", () => {
  it("clientCascadeInfo, projectCascadeInfo, contractCascadeInfo", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-914", project(clientId));
    const contractId = await createContract(contract(projectId));
    const seq1 = await nextCertificateSeq(contractId);
    const cert1 = await createCertificate(seq1, {
      contractId, number: "PC-1", date: "2026-07-01", submissionDate: null, dueDateOverride: null,
      description: null, grossMinor: 10_000_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED",
    });
    await createCertificate(await nextCertificateSeq(contractId), {
      contractId, number: "PC-2", date: "2026-07-10", submissionDate: null, dueDateOverride: null,
      description: null, grossMinor: 5_000_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "DRAFT",
    });
    await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-07-05", amountMinor: 1_000_000, method: "CASH", bank: null, reference: null, notes: null },
      [{ certificateId: cert1, amountMinor: 1_000_000 }],
    );
    const catId = await firstCategoryId();
    await createExpense({ date: "2026-07-01", categoryId: catId, description: "Site visit", projectId, supplier: null, amountMinor: 1_000_00, currency: "EGP", fxRateMicro: 1_000_000, attachmentPath: null });

    const cInfo = await contractCascadeInfo(contractId);
    expect(cInfo).toMatchObject({ certificates: 2, payments: 1 });

    const pInfo = await projectCascadeInfo(projectId);
    expect(pInfo).toMatchObject({ contracts: 1, certificates: 2, payments: 1, expenses: 1 });

    const clInfo = await clientCascadeInfo(clientId);
    expect(clInfo).toMatchObject({ projects: 1, contracts: 1, certificates: 2, payments: 1 });
  });
});

// ─── DELETE: full cascade from the top of the tree ──────────────────────

describe("delete: cascading a project removes every project-owned row", () => {
  it("contract, certificates, payments, allocations, stages, documents, assignments, person payments, their auto-expense, project expenses, and time entries all vanish", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-920", project(clientId));
    const contractId = await createContract(contract(projectId));
    const seq = await nextCertificateSeq(contractId);
    const certId = await createCertificate(seq, {
      contractId, number: "PC-1", date: "2026-07-01", submissionDate: null, dueDateOverride: null,
      description: null, grossMinor: 10_000_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED",
    });
    const paymentId = await createPayment(
      { contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-07-05", amountMinor: 1_000_000, method: "CASH", bank: null, reference: null, notes: null },
      [{ certificateId: certId, amountMinor: 1_000_000 }],
    );
    const stageId = await createStage({ projectId, name: "Concept", sortOrder: 0, startDate: null, endDate: null, status: "PLANNED", completionBp: 0, engineers: null, notes: null });
    await createDocument({ projectId, category: "OTHER", title: "Doc.pdf", path: "C:\\doc.pdf" });
    const personId = await createPerson({ type: "FREELANCER", name: "Eng F", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const assignmentId = await createAssignment({ personId, projectId, agreedMinor: 50_000_00, currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null });
    const personPaymentId = await createPersonPayment({ assignmentId, date: "2026-07-10", amountMinor: 20_000_00, note: null });
    const catId = await firstCategoryId();
    await createExpense({ date: "2026-07-01", categoryId: catId, description: "Printing", projectId, supplier: null, amountMinor: 1_000_00, currency: "EGP", fxRateMicro: 1_000_000, attachmentPath: null });
    await createTimeEntry({ personId, projectId, stageId, date: "2026-07-15", minutes: 60, billable: true, note: null });

    // sanity: everything is really there before we blow it up
    expect(raw(`SELECT id FROM contracts WHERE project_id=${projectId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM payment_certificates WHERE contract_id=${contractId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM payments WHERE contract_id=${contractId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM payment_certificate_allocations WHERE payment_id=${paymentId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM project_stages WHERE project_id=${projectId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM documents WHERE project_id=${projectId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM project_assignments WHERE project_id=${projectId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM person_payments WHERE assignment_id=${assignmentId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM expenses WHERE project_id=${projectId}`)).toHaveLength(2); // printing + auto team-payment expense
    expect(raw(`SELECT id FROM time_entries WHERE project_id=${projectId}`)).toHaveLength(1);

    await deleteProject(projectId);

    expect(raw(`SELECT id FROM contracts WHERE project_id=${projectId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM payment_certificates WHERE contract_id=${contractId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM payments WHERE contract_id=${contractId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM payment_certificate_allocations WHERE payment_id=${paymentId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM project_stages WHERE project_id=${projectId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM documents WHERE project_id=${projectId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM project_assignments WHERE project_id=${projectId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM person_payments WHERE id=${personPaymentId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM expenses WHERE project_id=${projectId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM time_entries WHERE project_id=${projectId}`)).toHaveLength(0);

    // the project itself is gone, but its client and the unrelated person survive
    expect(await getProject(projectId)).toBeNull();
    expect(await getClient(clientId)).not.toBeNull();
    expect(await getPerson(personId)).not.toBeNull();
  });

  it("deleting the client cascades through everything below it too", async () => {
    const clientId = await createClient(client());
    const projectId = await createProject("PRJ-2026-921", project(clientId));
    await createContract(contract(projectId));

    await deleteClient(clientId);

    expect(raw(`SELECT id FROM projects WHERE client_id=${clientId}`)).toHaveLength(0);
    expect(raw(`SELECT id FROM contracts WHERE project_id=${projectId}`)).toHaveLength(0);
    expect(await getClient(clientId)).toBeNull();
  });
});
