import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { computeDashboardOverview, type ContractInput } from "@mep/core";
import { select as harnessSelect, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject, deleteProject, updateProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createCertificate } from "../src/repositories/certificates";
import { createExpense } from "../src/repositories/expenses";
import { createPayment } from "../src/repositories/payments";
import {
  loadWorkspaceFinancials,
  loadWorkspaceFinancialsConsistently,
  type FinancialSelect,
} from "../src/repositories/financials";

beforeEach(() => resetDb());

async function fixture() {
  const clientId = await createClient({
    name: "Dashboard Audit Client",
    company: null,
    address: null,
    phone: null,
    email: null,
    taxNumber: null,
    contacts: null,
    notes: null,
  });
  const projectId = await createProject("DASH-AUD-001", {
    name: "Dashboard Audit Project",
    clientId,
    country: null,
    city: null,
    manager: null,
    discipline: "MULTI",
    projectType: null,
    status: "ACTIVE",
    currency: "EGP",
    fxRateMicro: 1_000_000,
    startDate: null,
    endDate: null,
    progressBp: 0,
    description: null,
  });
  const terms: ContractInput = {
    projectId,
    number: "DASH-AUD-C1",
    title: null,
    valueMinor: 1_000_00,
    vatBp: 0,
    retentionBp: 0,
    withholdingBp: 0,
    advanceMinor: 0,
    advanceRecoveryMethod: "PROPORTIONAL",
    performanceBondBp: 0,
    performanceBondBank: null,
    performanceBondExpiry: null,
    paymentTermsDays: 30,
    paymentTermsNotes: null,
    valuationMode: "LUMP_SUM",
    milestones: null,
    drawings: null,
    attachments: null,
    signedDate: "2026-01-01",
    notes: null,
  };
  const contractId = await createContract(terms);
  return { clientId, projectId, contractId };
}

describe("dashboard financial hardening", () => {
  it("retains certificate and cash FX history after a project currency revision", async () => {
    const { clientId, projectId, contractId } = await fixture();
    await createCertificate(1, {
      contractId,
      number: "PC-EGP",
      date: "2026-02-01",
      submissionDate: "2026-02-01",
      dueDateOverride: null,
      description: null,
      grossMinor: 100_00,
      discountMinor: 0,
      manualAdvanceRecoveryMinor: null,
      status: "APPROVED",
    });
    await createPayment({
      contractId,
      kind: "ADVANCE",
      number: "PAY-EGP",
      date: "2026-02-05",
      amountMinor: 100_00,
      method: "BANK_TRANSFER",
      bank: null,
      reference: null,
      notes: null,
    }, []);

    await updateProject(projectId, {
      name: "Dashboard Audit Project",
      clientId,
      country: null,
      city: null,
      manager: null,
      discipline: "MULTI",
      projectType: null,
      status: "ACTIVE",
      currency: "USD",
      fxRateMicro: 50_000_000,
      startDate: null,
      endDate: null,
      progressBp: 0,
      description: null,
    }, { effectiveDate: "2026-03-01", reason: "Approved currency conversion" });

    await createCertificate(2, {
      contractId,
      number: "PC-USD",
      date: "2026-04-01",
      submissionDate: "2026-04-01",
      dueDateOverride: null,
      description: null,
      grossMinor: 100_00,
      discountMinor: 0,
      manualAdvanceRecoveryMinor: null,
      status: "APPROVED",
    });
    await createPayment({
      contractId,
      kind: "ADVANCE",
      number: "PAY-USD",
      date: "2026-04-05",
      amountMinor: 100_00,
      method: "BANK_TRANSFER",
      bank: null,
      reference: null,
      notes: null,
    }, []);

    const workspace = await loadWorkspaceFinancials();
    expect(workspace.projects[0]).toMatchObject({
      revenueEgp: 510_000,
      totalActualCashInEgp: 510_000,
    });
    expect(workspace.cashIn.map((row) => row.egpMinor)).toEqual([10_000, 500_000]);
  });

  it("does not mix archived-project costs into a live-workspace dashboard", async () => {
    const { projectId } = await fixture();
    await createExpense({
      date: "2026-05-01",
      categoryId: 1,
      description: "Archived project cost",
      projectId,
      supplier: null,
      amountMinor: 25_000,
      currency: "EGP",
      fxRateMicro: 1_000_000,
      attachmentPath: null,
    });
    await deleteProject(projectId);

    const workspace = await loadWorkspaceFinancials();
    expect(workspace.projects).toHaveLength(0);
    expect(workspace.allExpenses).toHaveLength(0);
    expect(computeDashboardOverview(workspace.projects, workspace.allExpenses).cashOutEgp).toBe(0);
  });

  it("retries when a financial mutation commits during a pooled read", async () => {
    await fixture();
    let revisionRead = 0;
    let projectReads = 0;
    const read: FinancialSelect = async <T>(sql: string, params: unknown[] = []) => {
      if (sql.includes("COALESCE(MAX(id),0) AS revision")) {
        revisionRead += 1;
        return [{ revision: revisionRead === 1 ? 10 : 11 }] as T[];
      }
      if (sql.includes("SELECT p.*, c.name AS client_name")) projectReads += 1;
      return harnessSelect<T>(sql, params);
    };

    const workspace = await loadWorkspaceFinancialsConsistently(read);
    expect(workspace.projects).toHaveLength(1);
    expect(projectReads).toBe(2);
    expect(revisionRead).toBe(4);
  });

  it("fails closed instead of returning a repeatedly changing snapshot", async () => {
    await fixture();
    let revision = 0;
    const read: FinancialSelect = async <T>(sql: string, params: unknown[] = []) => {
      if (sql.includes("COALESCE(MAX(id),0) AS revision")) {
        revision += 1;
        return [{ revision }] as T[];
      }
      return harnessSelect<T>(sql, params);
    };
    await expect(loadWorkspaceFinancialsConsistently(read, 2))
      .rejects.toThrow("FINANCIAL_SNAPSHOT_BUSY");
  });
});
