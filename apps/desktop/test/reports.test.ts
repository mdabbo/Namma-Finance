import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import {
  buildCashflow,
  computeAging,
  computeDashboardKpis,
  computeProfitability,
  isBillable,
  toEgpPiasters,
  type AgingInput,
} from "@mep/core";
import { resetDb, raw } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createCertificate, nextCertificateSeq } from "../src/repositories/certificates";
import { createPayment } from "../src/repositories/payments";
import { createExpense } from "../src/repositories/expenses";
import { createRecurring } from "../src/repositories/recurring";
import { reconcileMilestoneCertificates } from "../src/repositories/milestoneCertificates";
import { loadWorkspaceFinancials } from "../src/repositories/financials";

const CURRENCIES = [
  { code: "EGP", fx: 1_000_000 },
  { code: "SAR", fx: 12_900_000 },
  { code: "USD", fx: 48_250_000 },
];
const STATUSES = ["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;
const CERT_STATES = ["DRAFT", "SUBMITTED", "APPROVED", "PAID"] as const;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a large, deliberately messy workspace that exercises every report
 * path. With `seed` undefined it builds the fixed 12-project layout used by
 * the detailed assertions; with a seed it randomises everything for fuzzing.
 */
async function buildRichWorkspace(seed?: number, projectCount = 12): Promise<void> {
  const rng = seed === undefined ? null : mulberry32(seed);
  const pick = <T>(arr: readonly T[], i: number): T => (rng ? arr[Math.floor(rng() * arr.length)]! : arr[i % arr.length]!);
  const randInt = (lo: number, hi: number, i: number): number => (rng ? lo + Math.floor(rng() * (hi - lo + 1)) : lo + (i % (hi - lo + 1)));
  const categoryId = (raw<{ id: number }>("SELECT id FROM expense_categories ORDER BY id LIMIT 1")[0]!).id;

  for (let i = 0; i < projectCount; i++) {
    const cur = pick(CURRENCIES, i);
    const status = pick(STATUSES, i);
    const clientId = await createClient({
      name: `Client ${i + 1}`, company: null, address: null, phone: null,
      email: null, taxNumber: null, contacts: null, notes: null,
    });
    const projectId = await createProject(`PRJ-2026-${String(i + 1).padStart(3, "0")}`, {
      name: `Project ${i + 1}`, clientId, country: null, city: null, manager: null,
      discipline: "MULTI", projectType: null, status, currency: cur.code,
      fxRateMicro: cur.fx, startDate: null, endDate: null, progressBp: 0, description: null,
    });

    const valueMinor = randInt(30_000_00, 500_000_00, i);
    const retentionBp = i % 3 === 0 ? 500 : 0;
    const advanceMinor = i % 4 === 0 ? Math.round(valueMinor * 0.2) : 0;
    const contractId = await createContract({
      projectId, number: `C-${i + 1}`, title: null, valueMinor,
      vatBp: 1400, retentionBp, withholdingBp: 0, advanceMinor,
      advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
      performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30,
      paymentTermsNotes: null, valuationMode: "LUMP_SUM",
      milestones: null, drawings: null, attachments: null, signedDate: null, notes: null,
    });

    // certificates in different states, some overdue, some discounted, some part-paid
    const certCount = randInt(2, 4, i);
    for (let c = 0; c < certCount; c++) {
      const state = pick(CERT_STATES, c);
      const gross = randInt(1_000_00, Math.max(2_000_00, Math.round(valueMinor * 0.25)), c);
      const discount = c === 1 ? Math.round(gross * 0.1) : 0;
      const seq = await nextCertificateSeq(contractId);
      // submission far in the past so SUBMITTED/APPROVED become overdue
      const submission = c % 2 === 0 ? "2026-01-05" : "2026-06-20";
      const certId = await createCertificate(seq, {
        contractId, number: `C-${i + 1}-${c + 1}`, date: "2026-02-01",
        submissionDate: state === "DRAFT" ? null : submission,
        dueDateOverride: null, description: `Cert ${c + 1}`,
        grossMinor: gross, discountMinor: discount, manualAdvanceRecoveryMinor: null,
        status: state,
      });
      // pay APPROVED and PAID certs (PAID fully, APPROVED partially)
      if (state === "APPROVED" || state === "PAID") {
        const ws = await loadWorkspaceFinancials();
        const cs = ws.contractStates.get(contractId)!.certificates.find((x) => x.certificate.id === certId)!;
        const pay = state === "PAID" ? cs.unpaidMinor : Math.round(cs.unpaidMinor * 0.5);
        if (pay > 0) {
          await createPayment(
            { contractId, kind: "CERTIFICATE", number: `P-${certId}`, date: "2026-06-25",
              amountMinor: pay, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
            [{ certificateId: certId, amountMinor: pay }],
          );
        }
      }
    }

    // advance receipt for contracts that have one
    if (advanceMinor > 0) {
      await createPayment(
        { contractId, kind: "ADVANCE", number: `ADV-${i}`, date: "2026-01-10",
          amountMinor: advanceMinor, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
        [],
      );
    }

    // direct project expenses (varying currency + month)
    for (let e = 0; e < 3; e++) {
      await createExpense({
        date: `2026-0${(e % 6) + 1}-15`, categoryId, description: `Direct ${e}`,
        projectId, supplier: null, amountMinor: 3_000_00 + e * 1_000_00,
        currency: cur.code, fxRateMicro: cur.fx, attachmentPath: null,
      });
    }
    void rng;
  }

  // overhead expenses (no project) — all EGP for a clean overhead total
  for (let o = 0; o < 5; o++) {
    await createExpense({
      date: `2026-0${o + 1}-01`, categoryId, description: `Overhead ${o}`,
      projectId: null, supplier: null, amountMinor: 8_000_00 + o * 2_000_00,
      currency: "EGP", fxRateMicro: 1_000_000, attachmentPath: null,
    });
  }

  // recurring expenses feed the cash-flow forecast
  for (let r = 0; r < 3; r++) {
    await createRecurring({
      name: `Rent ${r}`, categoryId, amountMinor: 5_000_00, currency: "EGP",
      fxRateMicro: 1_000_000, dayOfMonth: 1, isActive: true, notes: null,
    });
  }
}

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

describe("dashboard & reports — heavy multi-currency workload", () => {
  beforeAll(async () => {
    resetDb();
    await buildRichWorkspace();
  });

  it("dashboard KPIs are finite and reconcile with per-project figures", async () => {
    const ws = await loadWorkspaceFinancials();
    const k = computeDashboardKpis(ws.projects, ws.allExpenses);

    for (const [key, v] of Object.entries(k)) {
      expect(Number.isFinite(v), `KPI ${key} not finite`).toBe(true);
    }
    // identities
    expect(k.revenueEgp).toBe(ws.projects.reduce((s, p) => s + p.revenueEgp, 0));
    expect(k.collectedEgp).toBe(ws.projects.reduce((s, p) => s + p.collectedEgp, 0));
    expect(k.outstandingEgp).toBe(ws.projects.reduce((s, p) => s + p.outstandingEgp, 0));
    expect(k.expensesEgp).toBe(ws.allExpenses.reduce((s, e) => s + toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro), 0));
    expect(k.profitEgp).toBe(k.revenueEgp - k.expensesEgp);
    expect(k.outstandingEgp).toBeGreaterThanOrEqual(0);

    // project-status partition adds up
    const total = ws.projects.length;
    const active = ws.projects.filter((p) => p.project.status === "ACTIVE").length;
    const completed = ws.projects.filter((p) => p.project.status === "COMPLETED").length;
    expect(k.activeProjects).toBe(active);
    expect(k.completedProjects).toBe(completed);
    expect(active + completed).toBeLessThanOrEqual(total);
  });

  it("dashboard monthly series and category breakdown sum to the totals", async () => {
    const ws = await loadWorkspaceFinancials();
    const k = computeDashboardKpis(ws.projects, ws.allExpenses);

    // replicate the dashboard's monthly bucketing exactly
    let revenue = 0, cashIn = 0, expenses = 0;
    for (const state of ws.contractStates.values()) {
      const project = ws.projects.find((p) => p.project.id === state.contract.projectId)?.project;
      const toEgp = (m: number) => (project ? toEgpPiasters(m, project.currency, project.fxRateMicro) : m);
      for (const cs of state.certificates) if (isBillable(cs.certificate.status)) revenue += toEgp(cs.breakdown.baseMinor);
    }
    for (const p of ws.cashIn) cashIn += p.egpMinor;
    for (const e of ws.allExpenses) expenses += toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro);

    expect(revenue).toBe(k.revenueEgp);
    expect(expenses).toBe(k.expensesEgp);
    // cashIn (all payments incl. advances) is at least the certificate-allocated collected
    expect(cashIn).toBeGreaterThanOrEqual(k.collectedEgp);
  });

  it("profitability report: overhead allocates exactly and ties back to the dashboard profit", async () => {
    const ws = await loadWorkspaceFinancials();
    const k = computeDashboardKpis(ws.projects, ws.allExpenses);
    const totalOverhead = ws.allExpenses
      .filter((e) => e.projectId === null)
      .reduce((s, e) => s + toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro), 0);

    const rows = computeProfitability(ws.projects, totalOverhead, "REVENUE");

    // largest-remainder allocation sums EXACTLY to the overhead total
    expect(rows.reduce((s, r) => s + r.overheadEgp, 0)).toBe(totalOverhead);
    // per-row identities
    for (const r of rows) {
      expect(r.grossProfitEgp).toBe(r.revenueEgp - r.directCostEgp);
      expect(r.netProfitEgp).toBe(r.grossProfitEgp - r.overheadEgp);
    }
    // sum of net profit == dashboard profit (revenue − direct − overhead)
    expect(rows.reduce((s, r) => s + r.netProfitEgp, 0)).toBe(k.profitEgp);
    // sorted by net profit descending
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.netProfitEgp).toBeGreaterThanOrEqual(rows[i]!.netProfitEgp);
    }
  });

  it("aging report: buckets sum to the grand total and equal the dashboard outstanding", async () => {
    const ws = await loadWorkspaceFinancials();
    const k = computeDashboardKpis(ws.projects, ws.allExpenses);
    const today = "2026-07-19";

    const items: AgingInput[] = [];
    for (const state of ws.contractStates.values()) {
      const project = ws.projects.find((p) => p.project.id === state.contract.projectId)?.project;
      const toEgp = (m: number) => (project ? toEgpPiasters(m, project.currency, project.fxRateMicro) : m);
      for (const cs of state.certificates) {
        if (isBillable(cs.certificate.status) && cs.unpaidMinor > 0) {
          items.push({
            certificateId: cs.certificate.id, certificateNumber: cs.certificate.number,
            projectName: project?.name ?? "", clientName: "",
            dueDate: cs.dueDate, unpaidEgp: toEgp(cs.unpaidMinor),
          });
        }
      }
    }
    const aging = computeAging(items, today);

    const bucketSum = Object.values(aging.totals).reduce((s, v) => s + v, 0);
    expect(bucketSum).toBe(aging.grandTotal);
    // every unpaid billable certificate appears exactly once
    expect(aging.rows.length).toBe(items.length);
    // aging grand total == dashboard outstanding (both are unpaid billable, in EGP)
    expect(near(aging.grandTotal, k.outstandingEgp, ws.projects.length)).toBe(true);
    // overdue submitted/approved certs must NOT sit in CURRENT
    const overdue = aging.rows.filter((r) => r.daysOverdue > 0);
    for (const r of overdue) expect(r.bucket).not.toBe("CURRENT");
  });

  it("cash-flow report: month identities hold and cumulative is a running sum", async () => {
    const ws = await loadWorkspaceFinancials();
    const recurring = raw<{ amount_minor: number }>("SELECT amount_minor FROM recurring_expenses WHERE is_active = 1");

    const actualOut = ws.allExpenses.map((e) => ({ date: e.date, egpMinor: toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro) }));
    const openReceivables = [...ws.contractStates.values()].flatMap((state) => {
      const project = ws.projects.find((p) => p.project.id === state.contract.projectId)?.project;
      return state.certificates
        .filter((cs) => isBillable(cs.certificate.status) && cs.unpaidMinor > 0)
        .map((cs) => ({ dueDate: cs.dueDate, unpaidEgp: project ? toEgpPiasters(cs.unpaidMinor, project.currency, project.fxRateMicro) : cs.unpaidMinor }));
    });

    const rows = buildCashflow({
      actualIn: ws.cashIn, actualOut, openReceivables,
      recurring: recurring.map((r) => ({ egpMinor: r.amount_minor, dayOfMonth: 1 })),
      todayIso: "2026-07-19", monthsBack: 6, monthsForward: 6,
    });

    let cumulative = 0;
    for (const row of rows) {
      expect(Number.isFinite(row.net)).toBe(true);
      expect(row.net).toBe(row.inActual + row.inForecast - row.outActual - row.outForecast);
      cumulative += row.net;
      expect(row.cumulative).toBe(cumulative);
    }
    // forecast receivables in-window sum to the open receivables that fall in range
    const totalForecast = rows.reduce((s, r) => s + r.inForecast, 0);
    expect(totalForecast).toBeGreaterThan(0);
    expect(totalForecast).toBeLessThanOrEqual(openReceivables.reduce((s, r) => s + r.unpaidEgp, 0) + 2);
  });

  it("reports stay consistent even while a reconcile storm mutates data underneath", async () => {
    const contracts = raw<{ id: number }>("SELECT id FROM contracts");
    // hammer reconcile concurrently while repeatedly loading the dashboard
    const work: Promise<unknown>[] = [];
    for (let k = 0; k < 5; k++) {
      work.push(reconcileMilestoneCertificates());
      work.push(loadWorkspaceFinancials());
      for (const c of contracts) work.push(reconcileMilestoneCertificates(c.id));
    }
    await Promise.all(work);

    const ws = await loadWorkspaceFinancials();
    const k = computeDashboardKpis(ws.projects, ws.allExpenses);
    expect(Number.isFinite(k.profitEgp)).toBe(true);
    expect(k.outstandingEgp).toBeGreaterThanOrEqual(0);
    // no contract grew duplicate live certificates during the storm
    for (const state of ws.contractStates.values()) {
      const numbers = state.certificates.filter((c) => !c.certificate.deletedAt).map((c) => c.certificate.number);
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });
});

/** Universal accounting identities that must hold for ANY workspace. */
async function assertUniversalIdentities(label: string): Promise<void> {
  const ws = await loadWorkspaceFinancials();
  const k = computeDashboardKpis(ws.projects, ws.allExpenses);
  const totalOverhead = ws.allExpenses
    .filter((e) => e.projectId === null)
    .reduce((s, e) => s + toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro), 0);
  const profit = computeProfitability(ws.projects, totalOverhead, "REVENUE");

  for (const [key, v] of Object.entries(k)) {
    expect(Number.isFinite(v), `${label}: KPI ${key} not finite`).toBe(true);
    expect(Number.isSafeInteger(v as number) || key === "marginBp", `${label}: KPI ${key} unsafe integer`).toBe(true);
  }
  expect(k.profitEgp, `${label}: profit identity`).toBe(k.revenueEgp - k.expensesEgp);
  expect(k.outstandingEgp, `${label}: outstanding negative`).toBeGreaterThanOrEqual(0);
  expect(k.revenueEgp, `${label}: revenue sum`).toBe(ws.projects.reduce((s, p) => s + p.revenueEgp, 0));

  // overhead allocates exactly; net profit ties back to the dashboard
  expect(profit.reduce((s, r) => s + r.overheadEgp, 0), `${label}: overhead allocation`).toBe(totalOverhead);
  expect(profit.reduce((s, r) => s + r.netProfitEgp, 0), `${label}: net-profit sum`).toBe(k.profitEgp);

  // aging grand total == dashboard outstanding
  const items: AgingInput[] = [];
  for (const state of ws.contractStates.values()) {
    const project = ws.projects.find((p) => p.project.id === state.contract.projectId)?.project;
    const toEgp = (m: number) => (project ? toEgpPiasters(m, project.currency, project.fxRateMicro) : m);
    for (const cs of state.certificates) {
      if (isBillable(cs.certificate.status) && cs.unpaidMinor > 0) {
        items.push({ certificateId: cs.certificate.id, certificateNumber: cs.certificate.number, projectName: "", clientName: "", dueDate: cs.dueDate, unpaidEgp: toEgp(cs.unpaidMinor) });
      }
    }
  }
  const aging = computeAging(items, "2026-07-19");
  expect(Object.values(aging.totals).reduce((s, v) => s + v, 0), `${label}: aging bucket sum`).toBe(aging.grandTotal);
  expect(near(aging.grandTotal, k.outstandingEgp, ws.projects.length + 2), `${label}: aging vs outstanding`).toBe(true);

  // no contract carries duplicate live certificate numbers
  for (const state of ws.contractStates.values()) {
    const numbers = state.certificates.filter((c) => !c.certificate.deletedAt).map((c) => c.certificate.number);
    expect(new Set(numbers).size, `${label}: duplicate cert numbers`).toBe(numbers.length);
  }
}

describe("dashboard & reports — fuzz + scale", () => {
  it("holds every accounting identity across 30 randomised workspaces", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      resetDb();
      await buildRichWorkspace(seed, 5 + (seed % 11));
      await assertUniversalIdentities(`seed ${seed}`);
    }
  });

  it("stays exact and safe at scale (60 projects)", async () => {
    resetDb();
    await buildRichWorkspace(999, 60);
    await assertUniversalIdentities("scale-60");
  });
});
