import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject, deleteProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createCertificate, listCertificates } from "../src/repositories/certificates";
import { createExpense, listExpenses } from "../src/repositories/expenses";
import { createPayment, listPayments } from "../src/repositories/payments";
import { loadWorkspaceFinancials } from "../src/repositories/financials";

beforeEach(() => resetDb());

/**
 * Milestone 1-3 independent-audit regression: the finance list pages must
 * follow the same archived-project boundary as the hardened financial read
 * model. Before this fix an archived project's certificates stayed listed
 * with net payable / unpaid rendered as 0 because their contract state no
 * longer existed.
 */
describe("archived projects leave every finance surface together", () => {
  it("hides archived-project certificates, payments, and expenses from the finance lists", async () => {
    const clientId = await createClient({
      name: "Lifecycle Client",
      company: null,
      address: null,
      phone: null,
      email: null,
      taxNumber: null,
      contacts: null,
      notes: null,
    });
    const projectId = await createProject("ARCH-VIS-001", {
      name: "Archived Visibility Project",
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
    const contractId = await createContract({
      projectId,
      number: "ARCH-VIS-C1",
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
    });
    await createCertificate(1, {
      contractId,
      number: "ARCH-VIS-PC1",
      date: "2026-02-01",
      submissionDate: "2026-02-01",
      dueDateOverride: null,
      description: null,
      grossMinor: 500_00,
      discountMinor: 0,
      manualAdvanceRecoveryMinor: null,
      status: "APPROVED",
    });
    await createPayment({
      contractId,
      kind: "ADVANCE",
      number: "ARCH-VIS-PAY1",
      date: "2026-02-05",
      amountMinor: 100_00,
      method: "BANK_TRANSFER",
      bank: null,
      reference: null,
      notes: null,
    }, []);
    await createExpense({
      date: "2026-02-10",
      categoryId: 1,
      description: "Project cost",
      projectId,
      supplier: null,
      amountMinor: 40_00,
      currency: "EGP",
      fxRateMicro: 1_000_000,
      attachmentPath: null,
    });
    await createExpense({
      date: "2026-02-11",
      categoryId: 1,
      description: "Office overhead",
      projectId: null,
      supplier: null,
      amountMinor: 15_00,
      currency: "EGP",
      fxRateMicro: 1_000_000,
      attachmentPath: null,
    });

    expect(await listCertificates()).toHaveLength(1);
    expect(await listPayments()).toHaveLength(1);
    expect(await listExpenses()).toHaveLength(2);

    await deleteProject(projectId);

    // Lists agree with the hardened read model: the archived project's
    // financial history is preserved in the database and audit log but no
    // longer appears on any operational finance surface.
    expect(await listCertificates()).toHaveLength(0);
    expect(await listPayments()).toHaveLength(0);
    const expenses = await listExpenses();
    expect(expenses).toHaveLength(1);
    expect(expenses[0]!.projectId).toBeNull();

    const workspace = await loadWorkspaceFinancials();
    expect(workspace.projects).toHaveLength(0);
    expect(workspace.cashIn).toHaveLength(0);
    expect(workspace.allExpenses.map((expense) => expense.projectId)).toEqual([null]);
  });
});
