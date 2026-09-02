import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { execute, rawOne, resetDb } from "./db-harness";
import { createClient, deleteClient } from "../src/repositories/clients";
import { createProject, deleteProject } from "../src/repositories/projects";
import { createContract, deleteContract } from "../src/repositories/contracts";
import { createCertificate, deleteCertificate, nextCertificateSeq } from "../src/repositories/certificates";

/**
 * Milestone 3: the UI presents archive/void honestly. The reason the labels
 * can never say "delete" for these records is structural — the schema forbids
 * hard-deleting any primary financial record — so the only removal paths are
 * archive (reversible) and void (financial, history kept). These tests pin
 * that invariant and the reason capture against the real schema.
 */

beforeEach(() => resetDb());

let seq = 0;
async function workspace() {
  seq += 1;
  const clientId = await createClient({
    name: `Client ${seq}`, company: null, address: null, phone: null,
    email: null, taxNumber: null, contacts: null, notes: null,
  });
  const projectId = await createProject(`PRJ-2026-${String(seq).padStart(3, "0")}`, {
    name: `Project ${seq}`, clientId, country: null, city: null, manager: null,
    discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP",
    fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null,
  });
  const contractId = await createContract({
    projectId, number: `C-${seq}`, title: null, valueMinor: 1_000_000,
    vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0,
    advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
    performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30,
    paymentTermsNotes: null, valuationMode: "LUMP_SUM",
    milestones: null, drawings: null, attachments: null, signedDate: null, notes: null,
  });
  return { clientId, projectId, contractId };
}

async function draft(contractId: number, status: "DRAFT" | "APPROVED" = "DRAFT") {
  const s = await nextCertificateSeq(contractId);
  return createCertificate(s, {
    contractId, number: `PC-${contractId}-${s}`, date: "2026-07-01",
    submissionDate: "2026-07-01", dueDateOverride: null, description: null,
    grossMinor: 5_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status,
  });
}

const exists = (id: number) =>
  !!rawOne<{ id: number }>(`SELECT id FROM payment_certificates WHERE id=${id}`);

describe("the schema forbids deleting primary records", () => {
  // These are why the UI can only ever offer archive/void — a hard delete is
  // rejected at the database, so any "Delete" label would be a lie.
  it("refuses to hard-delete a certificate, even a draft", async () => {
    const { contractId } = await workspace();
    const id = await draft(contractId);
    await expect(execute(`DELETE FROM payment_certificates WHERE id=${id}`))
      .rejects.toThrow("PROTECTED_FINANCIAL_RECORD_USE_VOID");
    expect(exists(id)).toBe(true);
  });

  it("refuses to hard-delete a client", async () => {
    const { clientId } = await workspace();
    await expect(execute(`DELETE FROM clients WHERE id=${clientId}`))
      .rejects.toThrow("PROTECTED_RECORD_USE_ARCHIVE");
  });
});

describe("void and archive keep history with a recorded reason", () => {
  it("voids a certificate without deleting it and stores the reason", async () => {
    const { contractId } = await workspace();
    const id = await draft(contractId, "APPROVED");
    await deleteCertificate(id, "Client cancelled the scope");
    const row = rawOne<{ reason: string; voided: string | null }>(
      `SELECT void_reason AS reason, voided_at AS voided FROM payment_certificates WHERE id=${id}`,
    );
    expect(row?.voided).toBeTruthy();
    expect(row?.reason).toBe("Client cancelled the scope");
  });

  it("archives a client without deleting it and stores the reason", async () => {
    const { clientId } = await workspace();
    await deleteClient(clientId, "Merged into parent account");
    const row = rawOne<{ reason: string; archived: string | null }>(
      `SELECT archive_reason AS reason, archived_at AS archived FROM clients WHERE id=${clientId}`,
    );
    expect(row?.archived).toBeTruthy();
    expect(row?.reason).toBe("Merged into parent account");
  });

  it("archives a project without deleting it and stores the reason", async () => {
    const { projectId } = await workspace();
    await deleteProject(projectId, "Project cancelled by client");
    const row = rawOne<{ reason: string; archived: string | null }>(
      `SELECT archive_reason AS reason, archived_at AS archived FROM projects WHERE id=${projectId}`,
    );
    expect(row?.archived).toBeTruthy();
    expect(row?.reason).toBe("Project cancelled by client");
  });

  it("archives a contract without deleting it and stores the reason", async () => {
    const { contractId } = await workspace();
    await deleteContract(contractId, "Replaced by a new signed agreement");
    const row = rawOne<{ reason: string; archived: string | null }>(
      `SELECT archive_reason AS reason, archived_at AS archived FROM contracts WHERE id=${contractId}`,
    );
    expect(row?.archived).toBeTruthy();
    expect(row?.reason).toBe("Replaced by a new signed agreement");
  });

  it("falls back to a default reason when none is supplied", async () => {
    const { contractId } = await workspace();
    const id = await draft(contractId, "APPROVED");
    await deleteCertificate(id);
    const row = rawOne<{ reason: string }>(`SELECT void_reason AS reason FROM payment_certificates WHERE id=${id}`);
    expect(row?.reason).toBe("Voided by user");
  });
});
