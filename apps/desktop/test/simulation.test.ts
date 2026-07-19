import { beforeAll, describe, expect, it, vi } from "vitest";

// Back the app's real repositories with the migration-built SQLite harness.
vi.mock("../src/lib/db", async () => await import("./db-harness"));

import {
  computeDashboardKpis,
  computeTeamPayout,
  isMilestoneAchieved,
  parseMilestones,
  type ContractState,
} from "@mep/core";
import { resetDb, raw } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract } from "../src/repositories/contracts";
import { createStage, updateStage } from "../src/repositories/stages";
import { createPerson, createAssignment } from "../src/repositories/people";
import { setCertificateStatus } from "../src/repositories/certificates";
import { createPayment } from "../src/repositories/payments";
import { reconcileMilestoneCertificates } from "../src/repositories/milestoneCertificates";
import { loadWorkspaceFinancials } from "../src/repositories/financials";

/** Deterministic PRNG so any failure reproduces exactly. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MILESTONE_TITLES = ["Concept", "30%", "60%", "90%", "IFC"];

interface Built {
  projectId: number;
  contractId: number;
  contractNumber: string;
  valueMinor: number;
  stageIds: number[];
  assignmentIds: number[];
}

/** Mirror useStageMutations.update: mark the stage completed, then reconcile the project's milestone contracts. */
async function completeStage(projectId: number, stageId: number, name: string, order: number): Promise<void> {
  await updateStage(stageId, {
    projectId, name, sortOrder: order, startDate: "2026-01-01", endDate: "2026-03-01",
    status: "COMPLETED", completionBp: 10000, engineers: null, notes: null,
  });
  const contracts = raw<{ id: number }>(
    `SELECT id FROM contracts WHERE project_id = ${projectId} AND valuation_mode = 'MILESTONES'`,
  );
  for (const c of contracts) await reconcileMilestoneCertificates(c.id);
}

/** Mirror the Mark-paid flow: approve then fully pay the certificate's net payable. */
async function payCertificate(contractId: number, certId: number): Promise<void> {
  await setCertificateStatus(certId, "APPROVED");
  const ws = await loadWorkspaceFinancials();
  const state = ws.contractStates.get(contractId)!;
  const cs = state.certificates.find((c) => c.certificate.id === certId)!;
  if (cs.unpaidMinor <= 0) return;
  await createPayment(
    { contractId, kind: "CERTIFICATE", number: `PAY-${certId}`, date: "2026-04-01",
      amountMinor: cs.unpaidMinor, method: "BANK_TRANSFER", bank: null, reference: null, notes: null },
    [{ certificateId: certId, amountMinor: cs.unpaidMinor }],
  );
}

async function buildWorkspace(): Promise<Built[]> {
  const people: number[] = [];
  for (let p = 0; p < 20; p++) {
    people.push(await createPerson({
      type: p % 2 === 0 ? "EMPLOYEE" : "FREELANCER", name: `Person ${p + 1}`,
      specialization: "ENG", phone: null, email: null, bankAccount: null,
      hourlyRateMinor: null, monthlyRateMinor: null, currency: "EGP", notes: null, isActive: true,
    }));
  }

  const built: Built[] = [];
  for (let i = 0; i < 10; i++) {
    const clientId = await createClient({
      name: `Client ${i + 1}`, company: null, address: null, phone: null,
      email: null, taxNumber: null, contacts: null, notes: null,
    });
    const code = `PRJ-2026-${String(i + 1).padStart(3, "0")}`;
    const projectId = await createProject(code, {
      name: `Project ${i + 1}`, clientId, country: null, city: null, manager: null,
      discipline: "MULTI", projectType: null, status: "ACTIVE", currency: "EGP",
      fxRateMicro: 1_000_000, startDate: null, endDate: null, progressBp: 0, description: null,
    });

    // 5 stages, one per milestone
    const stageIds: number[] = [];
    for (let s = 0; s < 5; s++) {
      stageIds.push(await createStage({
        projectId, name: MILESTONE_TITLES[s]!, sortOrder: s, startDate: "2026-01-01",
        endDate: "2026-03-01", status: "PLANNED", completionBp: 0, engineers: null, notes: null,
      }));
    }

    // milestones (each 20%, linked to its stage) — plan totals 100%
    const milestones = MILESTONE_TITLES.map((title, s) => ({
      title, percentBp: 2000, stageId: stageIds[s]!, done: false, certificateId: null,
    }));
    const valueMinor = 100_000_00 + i * 50_000_00; // varying values
    const contractNumber = `C-${i + 1}`;
    const contractId = await createContract({
      projectId, number: contractNumber, title: null, valueMinor,
      vatBp: 1400, retentionBp: i % 3 === 0 ? 500 : 0, withholdingBp: 0,
      advanceMinor: i % 2 === 0 ? Math.round(valueMinor * 0.2) : 0,
      advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0,
      performanceBondBank: null, performanceBondExpiry: null, paymentTermsDays: 30,
      paymentTermsNotes: null, valuationMode: "MILESTONES",
      milestones: JSON.stringify(milestones), drawings: null, attachments: null,
      signedDate: null, notes: null,
    });

    // 2 team members per project
    const assignmentIds: number[] = [];
    for (let a = 0; a < 2; a++) {
      const personId = people[(i * 2 + a) % people.length]!;
      assignmentIds.push(await createAssignment({
        personId, projectId, agreedMinor: 20_000_00 + a * 5_000_00,
        currency: "EGP", fxRateMicro: 1_000_000, scope: null, progressNote: null,
      }));
    }

    built.push({ projectId, contractId, contractNumber, valueMinor, stageIds, assignmentIds });
  }
  return built;
}

// ── invariant checks ─────────────────────────────────────────────────────────

function assertNoInvariantViolations(ws: Awaited<ReturnType<typeof loadWorkspaceFinancials>>) {
  for (const state of ws.contractStates.values()) {
    const contract = state.contract;
    if (contract.valuationMode !== "MILESTONES") continue;
    const milestones = parseMilestones(contract.milestones);
    const completed = new Set(
      raw<{ id: number }>(`SELECT id FROM project_stages WHERE project_id = ${contract.projectId} AND status = 'COMPLETED'`).map((r) => r.id),
    );

    // (1) no duplicate live certificates sharing a number on the contract
    const liveByNumber = new Map<string, number>();
    for (const cs of state.certificates) {
      if (cs.certificate.deletedAt) continue;
      const n = cs.certificate.number;
      liveByNumber.set(n, (liveByNumber.get(n) ?? 0) + 1);
    }
    for (const [number, count] of liveByNumber) {
      expect(count, `contract ${contract.number}: duplicate certificate ${number}`).toBe(1);
    }

    // (2) certificate count never exceeds the milestone count (no runaway drafts)
    const liveCerts = state.certificates.filter((c) => !c.certificate.deletedAt).length;
    expect(liveCerts, `contract ${contract.number}: more certificates than milestones`).toBeLessThanOrEqual(milestones.length);

    // (3) every stored certificateId link points to a live certificate
    const liveIds = new Set(state.certificates.filter((c) => !c.certificate.deletedAt).map((c) => c.certificate.id));
    for (const m of milestones) {
      if (m.certificateId != null) {
        expect(liveIds.has(m.certificateId), `contract ${contract.number}: dangling certificateId ${m.certificateId} for "${m.title}"`).toBe(true);
      }
    }

    // (4) every achieved milestone is covered by a certificate (its link exists)
    for (const m of milestones) {
      if (isMilestoneAchieved(m, completed)) {
        expect(m.certificateId, `contract ${contract.number}: achieved milestone "${m.title}" has NO certificate`).not.toBeNull();
      }
    }

    // (5) money never goes backwards
    expect(state.totalPaidMinor).toBeLessThanOrEqual(state.totalDueMinor + 1);
    expect(state.outstandingMinor).toBeGreaterThanOrEqual(-1);
  }
}

describe("NAMAA Finance — 10 projects × 20 people lifecycle simulation", () => {
  beforeAll(() => resetDb());

  it("sequential lifecycle: complete stages → certificates → pay → team payables stay consistent", async () => {
    const built = await buildWorkspace();
    const rng = mulberry32(42);

    // complete a random subset of stages per project (mirrors the UI mutation)
    for (const b of built) {
      for (let s = 0; s < b.stageIds.length; s++) {
        if (rng() < 0.7) await completeStage(b.projectId, b.stageIds[s]!, MILESTONE_TITLES[s]!, s);
      }
    }

    let ws = await loadWorkspaceFinancials();
    assertNoInvariantViolations(ws);

    // pay every draft certificate that now exists
    for (const b of built) {
      const state = ws.contractStates.get(b.contractId)!;
      for (const cs of state.certificates) {
        if (cs.certificate.status === "DRAFT" && !cs.certificate.deletedAt) {
          await payCertificate(b.contractId, cs.certificate.id);
        }
      }
    }

    ws = await loadWorkspaceFinancials();
    assertNoInvariantViolations(ws);

    // (6) team payables: a paid milestone must release the team members' share
    const paidAssignments = raw<{ assignment_id: number }>("SELECT DISTINCT assignment_id FROM person_payments");
    void paidAssignments;
    for (const b of built) {
      const states = [...ws.contractStates.values()].filter((s) => s.contract.projectId === b.projectId);
      const anyPaid = states.some((s) => s.certificates.some((c) => c.certificate.status === "PAID"));
      if (!anyPaid) continue;
      for (const assignmentId of b.assignmentIds) {
        const arow = raw<{ agreed_minor: number }>(`SELECT agreed_minor FROM project_assignments WHERE id = ${assignmentId}`)[0]!;
        const payout = computeTeamPayout(arow.agreed_minor, states as ContractState[], 0);
        expect(payout.releasedMinor, `assignment ${assignmentId}: paid project but nothing released to team`).toBeGreaterThan(0);
      }
    }

    // (7) dashboard KPIs are finite and internally consistent
    const kpis = computeDashboardKpis(ws.projects, ws.allExpenses);
    for (const [k, v] of Object.entries(kpis)) {
      expect(Number.isFinite(v), `dashboard KPI ${k} is not finite`).toBe(true);
    }
    // collected is cash incl. VAT, so it exceeds ex-VAT revenue — the real
    // bound is that we never collect more than the net payable that is due
    const totalDue = ws.projects.reduce((s, p) => s + p.totalDueMinor, 0);
    const totalPaid = ws.projects.reduce((s, p) => s + p.totalPaidMinor, 0);
    expect(totalPaid).toBeLessThanOrEqual(totalDue + 1);
    expect(kpis.outstandingEgp).toBeGreaterThanOrEqual(-1);
  });

  it("CONCURRENCY: a stage-complete reconcile racing the background sweep must not double-create or lose links", async () => {
    resetDb();
    const built = await buildWorkspace();
    const b = built[0]!;

    // complete all 5 stages so every milestone is achieved
    for (let s = 0; s < b.stageIds.length; s++) {
      await updateStage(b.stageIds[s]!, {
        projectId: b.projectId, name: MILESTONE_TITLES[s]!, sortOrder: s, startDate: "2026-01-01",
        endDate: "2026-03-01", status: "COMPLETED", completionBp: 10000, engineers: null, notes: null,
      });
    }

    // the race: the targeted reconcile (from the mutation) fires at the SAME time
    // as the global background sweep (main.tsx runs it on startup + every 10 min)
    await Promise.all([
      reconcileMilestoneCertificates(b.contractId),
      reconcileMilestoneCertificates(), // global sweep, all contracts
      reconcileMilestoneCertificates(b.contractId),
    ]);

    const ws = await loadWorkspaceFinancials();
    assertNoInvariantViolations(ws);

    // exactly 5 certificates — one per achieved milestone, no duplicates, no losses
    const state = ws.contractStates.get(b.contractId)!;
    const live = state.certificates.filter((c) => !c.certificate.deletedAt);
    expect(live.length, "expected exactly one certificate per achieved milestone").toBe(5);
  });

  it("STORM: heavy concurrent reconciles never lose a link, so paid milestones always notify the team", async () => {
    resetDb();
    const built = await buildWorkspace();

    // complete every stage on every project, then unleash a burst of concurrent
    // reconciles (targeted + global sweeps interleaving) across all projects
    for (const b of built) {
      for (let s = 0; s < b.stageIds.length; s++) {
        await updateStage(b.stageIds[s]!, {
          projectId: b.projectId, name: MILESTONE_TITLES[s]!, sortOrder: s, startDate: "2026-01-01",
          endDate: "2026-03-01", status: "COMPLETED", completionBp: 10000, engineers: null, notes: null,
        });
      }
    }
    const burst: Promise<number>[] = [];
    for (let k = 0; k < 8; k++) {
      burst.push(reconcileMilestoneCertificates()); // global sweeps
      for (const b of built) burst.push(reconcileMilestoneCertificates(b.contractId));
    }
    await Promise.all(burst);

    let ws = await loadWorkspaceFinancials();
    assertNoInvariantViolations(ws);
    // exactly 5 live certs per contract — no duplicates from the storm
    for (const b of built) {
      const live = ws.contractStates.get(b.contractId)!.certificates.filter((c) => !c.certificate.deletedAt);
      expect(live.length, `contract ${b.contractNumber}: storm produced ${live.length} certs`).toBe(5);
    }

    // pay everything, then EVERY team member on EVERY project must be owed money
    for (const b of built) {
      for (const cs of ws.contractStates.get(b.contractId)!.certificates) {
        if (cs.certificate.status === "DRAFT" && !cs.certificate.deletedAt) {
          await payCertificate(b.contractId, cs.certificate.id);
        }
      }
    }
    ws = await loadWorkspaceFinancials();
    assertNoInvariantViolations(ws);
    for (const b of built) {
      const states = [...ws.contractStates.values()].filter((s) => s.contract.projectId === b.projectId) as ContractState[];
      for (const assignmentId of b.assignmentIds) {
        const arow = raw<{ agreed_minor: number }>(`SELECT agreed_minor FROM project_assignments WHERE id = ${assignmentId}`)[0]!;
        const payout = computeTeamPayout(arow.agreed_minor, states, 0);
        expect(payout.dueMinor, `assignment ${assignmentId}: fully paid project owes team nothing (lost notification)`).toBeGreaterThan(0);
      }
    }
  });
});
