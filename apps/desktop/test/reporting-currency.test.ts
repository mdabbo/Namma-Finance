import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import {
  EGP_VALUATION,
  computeDashboardOverview,
  dashboardCashInComponentsReconcile,
  fromEgpPiasters,
  reportingValuation,
  selectOpenReceivables,
  toEgpPiasters,
} from "@mep/core";
import { rawExec, resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createCertificate } from "../src/repositories/certificates";
import { createPayment } from "../src/repositories/payments";
import { createExpense } from "../src/repositories/expenses";
import { loadWorkspaceFinancials } from "../src/repositories/financials";
import { financeContractInputs, expenseSectionKpis } from "../src/features/finance/financeSectionModel";

/**
 * Reporting currency — the reported defect, end to end through the real
 * repositories and a real database.
 *
 * A test project: one SAR 325,000 contract, reporting currency SAR. The
 * contract page showed SAR 325,000; the dashboard showed SAR 317,031.19, and
 * its receivable SAR 79,257.80 against SAR 81,250. Both were off by the same
 * factor — the rate stored on the project when it was created, divided by the
 * rate in the currencies table that day.
 *
 * The same defect was fixed in July 2026 after user testing and returned when
 * the dashboard maths was centralised, because nothing asserted it.
 */

const SAR_AT_SIGNING = 12_681_248;
const SAR_TODAY = 13_000_000;
const USD_AT_SIGNING = 48_000_000;

async function sarProject() {
  const clientId = await createClient({ name: "RGU", company: null, address: null, phone: null,
    email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject("PRJ-2026-002", { name: "CASA", clientId,
    country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE",
    currency: "SAR", fxRateMicro: SAR_AT_SIGNING, startDate: null, endDate: null, progressBp: 0, description: null });
  const contractId = await createContract({ projectId, number: "CON-2026-0001", title: null,
    valueMinor: 32_500_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0,
    advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null,
    performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
    valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null,
    signedDate: "2026-01-01", notes: null });
  const certificateId = await createCertificate(1, { contractId, number: "PC-1", date: "2026-02-01",
    submissionDate: "2026-02-01", dueDateOverride: null, description: "Milestone 1 — 25%",
    grossMinor: 8_125_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });
  return { clientId, projectId, contractId, certificateId };
}

describe("reporting currency: a SAR workspace reported in SAR", () => {
  beforeEach(() => {
    resetDb();
    // Today's rate has moved since the project was created.
    rawExec(`UPDATE currencies SET fx_rate_micro=${SAR_TODAY} WHERE code='SAR'`);
  });

  it("shows the contract and its receivable at face value", async () => {
    const { projectId } = await sarProject();
    const workspace = await loadWorkspaceFinancials(reportingValuation("SAR", SAR_TODAY));
    const overview = computeDashboardOverview(workspace.projects, workspace.allExpenses, workspace.valuation);

    expect(workspace.valuation.currency).toBe("SAR");
    expect(overview.contractValueEgp).toBe(32_500_000); // SAR 325,000.00 — was 317,031.19
    expect(overview.outstandingReceivablesEgp).toBe(8_125_000); // SAR 81,250.00 — was 79,257.80

    // The dashboard now agrees with the contract page, which reads the
    // project's own figures.
    const project = workspace.projects.find((row) => row.project.id === projectId)!;
    expect(overview.contractValueEgp).toBe(project.contractValueMinor);
    expect(overview.outstandingReceivablesEgp).toBe(project.outstandingReceivablesMinor);

    const [receivable] = selectOpenReceivables(financeContractInputs(workspace), workspace.valuation);
    expect(receivable?.unpaidEgp).toBe(8_125_000);
  });

  it("is what the old pipeline got wrong: EGP at the project rate, back at today's", async () => {
    await sarProject();
    const pivot = await loadWorkspaceFinancials(EGP_VALUATION);
    const overview = computeDashboardOverview(pivot.projects, pivot.allExpenses, EGP_VALUATION);
    // An executable record of the defect, on these rates.
    expect(fromEgpPiasters(overview.contractValueEgp, "SAR", SAR_TODAY)).toBe(31_703_120);
    expect(fromEgpPiasters(overview.outstandingReceivablesEgp, "SAR", SAR_TODAY)).toBe(7_925_780);
  });

  it("does not move when the central-bank rate does", async () => {
    await sarProject();
    const figures = [];
    for (const rateToday of [11_000_000, SAR_TODAY, 15_250_000]) {
      rawExec(`UPDATE currencies SET fx_rate_micro=${rateToday} WHERE code='SAR'`);
      const workspace = await loadWorkspaceFinancials(reportingValuation("SAR", rateToday));
      const overview = computeDashboardOverview(workspace.projects, workspace.allExpenses, workspace.valuation);
      figures.push([overview.contractValueEgp, overview.outstandingReceivablesEgp]);
    }
    expect(figures).toEqual([[32_500_000, 8_125_000], [32_500_000, 8_125_000], [32_500_000, 8_125_000]]);
  });

  it("values cash, expenses and the monthly series at face value, with parts that sum", async () => {
    const { projectId, contractId, certificateId } = await sarProject();
    await createPayment({ contractId, kind: "CERTIFICATE", number: "PAY-1", date: "2026-03-01",
      amountMinor: 5_000_001, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
    [{ certificateId, amountMinor: 3_333_333 }]);
    await createPayment({ contractId, kind: "ADVANCE", number: "ADV-1", date: "2026-01-10",
      amountMinor: 3_250_000, method: "BANK_TRANSFER", bank: null, reference: null, notes: null }, []);
    await createExpense({ date: "2026-03-05", categoryId: 1, description: "Site visit", projectId,
      supplier: null, amountMinor: 1_234_567, currency: "SAR", fxRateMicro: SAR_AT_SIGNING, attachmentPath: null });

    const workspace = await loadWorkspaceFinancials(reportingValuation("SAR", SAR_TODAY));
    const overview = computeDashboardOverview(workspace.projects, workspace.allExpenses, workspace.valuation);

    expect(overview.totalCashInEgp).toBe(5_000_001 + 3_250_000);
    expect(overview.certificateCollectionsEgp).toBe(3_333_333);
    expect(overview.unallocatedCustomerCreditEgp).toBe(5_000_001 - 3_333_333);
    expect(overview.advanceReceivedEgp).toBe(3_250_000);
    expect(dashboardCashInComponentsReconcile(overview)).toBe(true);
    expect(overview.cashOutEgp).toBe(1_234_567);
    expect(overview.netCashPositionEgp).toBe(5_000_001 + 3_250_000 - 1_234_567);
    expect(overview.outstandingReceivablesEgp).toBe(8_125_000 - 3_333_333);

    expect(workspace.cashIn.map((row) => row.egpMinor).sort((a, b) => a - b)).toEqual([3_250_000, 5_000_001]);
    const kpis = expenseSectionKpis(workspace.allExpenses, null, "2026-03-20", workspace.valuation);
    expect(kpis.totalEgp).toBe(1_234_567);
    expect(workspace.costsByProject.get(projectId)!.actualPaidCostEgp).toBe(1_234_567);
  });
});

describe("reporting currency: a mixed portfolio", () => {
  beforeEach(() => {
    resetDb();
    rawExec(`UPDATE currencies SET fx_rate_micro=${SAR_TODAY} WHERE code='SAR'`);
  });

  async function mixedPortfolio() {
    const sar = await sarProject();
    const usdProjectId = await createProject("PRJ-2026-003", { name: "Tower", clientId: sar.clientId,
      country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE",
      currency: "USD", fxRateMicro: USD_AT_SIGNING, startDate: null, endDate: null, progressBp: 0, description: null });
    await createContract({ projectId: usdProjectId, number: "CON-2026-0002", title: null,
      valueMinor: 10_000_000, vatBp: 0, retentionBp: 0, withholdingBp: 0, advanceMinor: 0,
      advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null,
      performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
      valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null,
      signedDate: "2026-01-01", notes: null });
    await createExpense({ date: "2026-03-05", categoryId: 1, description: "Office rent", projectId: null,
      supplier: null, amountMinor: 26_000_000, currency: "EGP", fxRateMicro: 1_000_000, attachmentPath: null });
    return sar;
  }

  it("adds SAR at face value to foreign amounts valued through the pivot", async () => {
    await mixedPortfolio();
    const workspace = await loadWorkspaceFinancials(reportingValuation("SAR", SAR_TODAY));
    const overview = computeDashboardOverview(workspace.projects, workspace.allExpenses, workspace.valuation);
    const usdInSar = fromEgpPiasters(toEgpPiasters(10_000_000, "USD", USD_AT_SIGNING), "SAR", SAR_TODAY);

    expect(overview.contractValueEgp).toBe(32_500_000 + usdInSar);
    // EGP 260,000.00 of overhead at today's SAR rate.
    expect(overview.cashOutEgp).toBe(2_000_000);
  });

  it("leaves an EGP report exactly as the pivot always computed it", async () => {
    await mixedPortfolio();
    const workspace = await loadWorkspaceFinancials(EGP_VALUATION);
    const overview = computeDashboardOverview(workspace.projects, workspace.allExpenses, EGP_VALUATION);
    expect(overview.contractValueEgp).toBe(
      toEgpPiasters(32_500_000, "SAR", SAR_AT_SIGNING) + toEgpPiasters(10_000_000, "USD", USD_AT_SIGNING),
    );
    expect(overview.cashOutEgp).toBe(26_000_000);
  });
});

/**
 * The regression came from a conversion applied in the view after the totals
 * had been summed. These guards make that shape impossible to reintroduce
 * quietly: desktop code may not reach for the pivot conversions at all, and
 * the display hook has no `convert` to call.
 */
describe("reporting currency: no second conversion in the desktop", () => {
  const SRC = join(import.meta.dirname, "..", "src");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  const relative = (path: string) => path.slice(SRC.length + 1).replace(/\\/g, "/");

  it("never converts through the EGP pivot outside the core valuation", () => {
    const offenders = sources(SRC)
      .filter((path) => /\b(toEgpPiasters|fromEgpPiasters)\b/.test(readFileSync(path, "utf8")))
      .map(relative);
    expect(offenders).toEqual([]);
  });

  it("names the pivot valuation only where contract states alone are read", () => {
    const users = sources(SRC)
      .filter((path) => /\bEGP_VALUATION\b/.test(readFileSync(path, "utf8")))
      .map(relative);
    expect(users).toEqual(["repositories/financials.ts"]);
  });

  it("gives views a formatter and no converter", () => {
    const hook = readFileSync(join(SRC, "lib", "baseCurrency.ts"), "utf8");
    const body = hook.slice(hook.indexOf("export function useBaseMoney"));
    expect(body).not.toMatch(/\bconvert\w*\s*[:(,]/);
    expect(sources(SRC)
      .filter((path) => /\bbase\.convert\w*\(/.test(readFileSync(path, "utf8")))
      .map(relative)).toEqual([]);
  });
});
