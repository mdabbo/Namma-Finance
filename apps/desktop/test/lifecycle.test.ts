import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { raw, rawExec, resetDb } from "./db-harness";
import { createClient, deleteClient, listClients } from "../src/repositories/clients";
import { createProject, deleteProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createPayment, deletePayment, listPayments } from "../src/repositories/payments";
import { createPerson, createAssignment, createPersonPayment, deletePersonPayment, listPersonPayments } from "../src/repositories/people";

beforeEach(() => resetDb());

async function fixture() {
  const clientId = await createClient({ name: "Lifecycle Client", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject("PRJ-2026-LIFE", { name: "Lifecycle Project", clientId, country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP", fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null });
  const contractId = await createContract({ projectId, number: "LIFE-C1", title: null, valueMinor: 100_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0, advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null, valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null, signedDate: null, notes: null });
  return { clientId, projectId, contractId };
}

describe("Milestone 3 immutable lifecycle", () => {
  it("archives a client without deleting its project or contract", async () => {
    const { clientId, projectId, contractId } = await fixture();
    await deleteClient(clientId);

    expect(await listClients()).toHaveLength(0);
    expect(await listClients(true)).toHaveLength(1);
    expect(raw(`SELECT id FROM projects WHERE id=${projectId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM contracts WHERE id=${contractId}`)).toHaveLength(1);
  });

  it("archives a project without cascading financial history", async () => {
    const { projectId, contractId } = await fixture();
    const paymentId = await createPayment({ contractId, kind: "ADVANCE", number: "PAY-LIFE", date: "2026-07-21", amountMinor: 10_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null }, []);
    await deleteProject(projectId);

    expect(raw(`SELECT archived_at FROM projects WHERE id=${projectId}`)[0]?.archived_at).toBeTruthy();
    expect(raw(`SELECT id FROM contracts WHERE id=${contractId}`)).toHaveLength(1);
    expect(raw(`SELECT id FROM payments WHERE id=${paymentId}`)).toHaveLength(1);
  });

  it("voids a payment but preserves the original row and excludes it by default", async () => {
    const { contractId } = await fixture();
    const paymentId = await createPayment({ contractId, kind: "ADVANCE", number: "PAY-VOID", date: "2026-07-21", amountMinor: 10_000, method: "CASH", bank: null, reference: null, notes: null }, []);
    await deletePayment(paymentId);

    expect(await listPayments()).toHaveLength(0);
    const row = raw<{ voided_at: string; void_reason: string }>(`SELECT voided_at, void_reason FROM payments WHERE id=${paymentId}`)[0];
    expect(row?.voided_at).toBeTruthy();
    expect(row?.void_reason).toBeTruthy();
  });

  it("reverses a person payment and its expense without physical deletion", async () => {
    const { projectId } = await fixture();
    const personId = await createPerson({ type: "FREELANCER", name: "Lifecycle Person", specialization: null, phone: null, email: null, bankAccount: null, hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true });
    const assignmentId = await createAssignment({ personId, projectId, agreedMinor: 20_000, currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null });
    const paymentId = await createPersonPayment({ assignmentId, date: "2026-07-21", amountMinor: 5_000, note: "earned fee" });
    await deletePersonPayment(paymentId);

    expect(await listPersonPayments([assignmentId])).toHaveLength(0);
    expect(raw("SELECT id FROM person_payments")).toHaveLength(2);
    expect(raw("SELECT id FROM expenses WHERE person_payment_id IS NOT NULL")).toHaveLength(2);
    expect(raw<{ reversal_of_id: number }>(`SELECT reversal_of_id FROM person_payments WHERE reversal_of_id=${paymentId}`)[0]?.reversal_of_id).toBe(paymentId);
  });

  it("database guards reject direct physical deletion", async () => {
    const { clientId } = await fixture();
    expect(() => rawExec(`DELETE FROM clients WHERE id=${clientId}`)).toThrow("PROTECTED_RECORD_USE_ARCHIVE");
    expect(raw(`SELECT id FROM clients WHERE id=${clientId}`)).toHaveLength(1);
  });

  it("rejects repeated archive/void actions instead of silently succeeding", async () => {
    const { clientId, contractId } = await fixture();
    await deleteClient(clientId);
    await expect(deleteClient(clientId)).rejects.toThrow("CLIENT_NOT_FOUND_OR_ARCHIVED");

    const paymentId = await createPayment({ contractId, kind: "ADVANCE", number: "PAY-REPEAT", date: "2026-07-21", amountMinor: 1_000, method: "CASH", bank: null, reference: null, notes: null }, []);
    await deletePayment(paymentId);
    await expect(deletePayment(paymentId)).rejects.toThrow("PAYMENT_NOT_FOUND_OR_VOIDED");
  });
});
