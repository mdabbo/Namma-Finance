import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * The archived boundary has to be the SAME boundary in every engine.
 *
 * The read model excluded an archived project's certificates while the
 * reconciliation and allocation engine still walked them, so the two could
 * compute over different rows for the same contract. Nothing compared them
 * directly yet, which is exactly why it went unnoticed — any future figure
 * derived from both would have disagreed silently.
 *
 * Only the selections that feed FINANCIAL STATE are checked. Plenty of other
 * queries read payment_certificates and must not have this boundary: the next
 * sequence number, for instance, has to count every certificate on the contract
 * or it would reissue a seq that an archived row already holds.
 */
describe("every engine applies the same archived boundary", () => {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  /** The financial-state selections, named by the declaration that owns them. */
  const SELECTIONS: { file: string; marker: string; lines: number; what: string }[] = [
    {
      file: "src/repositories/payments.ts",
      marker: "async function loadContractPayables",
      lines: 20,
      what: "the reconciliation double",
    },
    {
      file: "src-tauri/src/lib.rs",
      marker: "async fn load_contract_payables",
      lines: 25,
      what: "the shipped Rust engine",
    },
    {
      file: "src/repositories/financials.ts",
      marker: "read<CertificateRow>",
      lines: 8,
      what: "the financial read model",
    },
    {
      file: "src/repositories/certificates.ts",
      marker: "FROM payment_certificates pc",
      lines: 6,
      what: "the certificates list",
    },
  ];

  it.each(SELECTIONS.map((s) => [s.what, s] as const))(
    "%s selects certificates inside the archived boundary",
    (_what, selection) => {
      const source = readFileSync(join(src, selection.file), "utf8");
      const at = source.indexOf(selection.marker);
      expect(at, `${selection.file}: marker "${selection.marker}" not found`).toBeGreaterThan(-1);
      const window = source.slice(at).split(/\n/).slice(0, selection.lines).join("\n");

      expect(window, `${selection.file} must exclude archived contracts`)
        .toMatch(/c\.archived_at IS NULL/);
      expect(window, `${selection.file} must exclude archived projects`)
        .toMatch(/p\.archived_at IS NULL/);
      expect(window, `${selection.file} must exclude voided certificates`)
        .toMatch(/voided_at IS NULL/);
    },
  );

  it("keeps the mobile workspace on the same boundary as the desktop read model", () => {
    // fetchAll filters only the sync tombstone, so archived projects and
    // contracts arrived as live rows and their money was counted as current.
    const mobile = readFileSync(resolve(src, "../mobile/src/lib/workspace.ts"), "utf8");
    expect(mobile).toContain("const isLive =");
    expect(mobile).toMatch(/archived_at == null/);
    expect(mobile).toMatch(/voided_at == null/);
    // Certificates and payments follow their contract, which follows its project.
    expect(mobile).toMatch(/liveProjectUuids/);
    expect(mobile).toMatch(/liveContractUuids/);
  });
});
