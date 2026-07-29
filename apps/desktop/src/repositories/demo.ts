import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient, deleteClient } from "./clients";
import { createProject, deleteProject } from "./projects";
import { createContract } from "./contracts";
import { createCertificate } from "./certificates";
import { createPayment } from "./payments";
import { createExpense, deleteExpense, listCategories } from "./expenses";
import { createPerson, createAssignment, deletePerson } from "./people";
import { createStage } from "./stages";
import { createTimeEntry } from "./timeEntries";
import { reserveNextNumber } from "./numbering";
import { loadSettings, saveSetting } from "../lib/settings";
import { todayIso } from "../lib/format";

/**
 * Optional demo workspace: realistic engineering-office records created
 * through the ordinary repository functions so numbering, audit evidence, and
 * payment-driven certificate statuses are all real. Every record is clearly
 * marked, and removal uses the normal lifecycle operations (archive / void),
 * so the audit trail of the demo period remains intact.
 */

export const DEMO_TAG = "Demo";
const DEMO_NOTE = "DEMO_WORKSPACE";

export interface DemoWorkspaceRefs {
  clientIds: number[];
  projectIds: number[];
  personIds: number[];
  overheadExpenseIds: number[];
}

export function parseDemoWorkspace(raw: string): DemoWorkspaceRefs | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const refs = parsed as DemoWorkspaceRefs;
    const ids = (value: unknown): value is number[] =>
      Array.isArray(value) && value.every((item) => Number.isSafeInteger(item));
    return ids(refs.clientIds) && ids(refs.projectIds) && ids(refs.personIds) && ids(refs.overheadExpenseIds)
      ? refs
      : null;
  } catch {
    return null;
  }
}

function isoDaysAgo(days: number): string {
  const [y, m, d] = todayIso().split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export async function createDemoWorkspace(): Promise<void> {
  const settings = await loadSettings();
  if (parseDemoWorkspace(settings.demoWorkspace)) throw new Error("DEMO_ALREADY_LOADED");
  const refs: DemoWorkspaceRefs = {
    clientIds: [],
    projectIds: [],
    personIds: [],
    overheadExpenseIds: [],
  };
  try {
    await seedDemoWorkspace(refs);
  } catch (error) {
    // Best-effort rollback via the same lifecycle operations so a failed seed
    // never strands half a demo workspace without a removal handle.
    await removeDemoRefs(refs).catch(() => undefined);
    throw error;
  }
  await saveSetting("demoWorkspace", JSON.stringify(refs));
}

async function seedDemoWorkspace(refs: DemoWorkspaceRefs): Promise<void> {
  const clientId = await createClient({
    name: `Al Nour Developments — ${DEMO_TAG}`,
    company: "Al Nour Developments S.A.E.",
    address: "New Cairo, Egypt",
    phone: "+20 2 1234 5678",
    email: "projects@alnour-demo.example",
    taxNumber: null,
    contacts: null,
    notes: DEMO_NOTE,
  });
  refs.clientIds.push(clientId);

  // All numbers are reserved through the real sequences so repeated demo
  // load/remove cycles never collide with archived demo records.
  const towerProjectId = await createProject(await reserveNextNumber("PROJECT", "DEMO"), {
    name: `HQ Tower — MEP Design (${DEMO_TAG})`,
    clientId,
    country: "Egypt",
    city: "Cairo",
    manager: "Sara El-Sayed",
    discipline: "MULTI",
    projectType: "Commercial tower",
    status: "ACTIVE",
    currency: "EGP",
    fxRateMicro: 1_000_000,
    startDate: isoDaysAgo(120),
    endDate: null,
    progressBp: 4_500,
    description: DEMO_NOTE,
  });
  refs.projectIds.push(towerProjectId);
  const towerContractId = await createContract({
    projectId: towerProjectId,
    number: await reserveNextNumber("CONTRACT", "DEMOC"),
    title: "MEP design services — HQ tower",
    valueMinor: 850_000_00,
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
    signedDate: isoDaysAgo(110),
    notes: DEMO_NOTE,
  });
  await createStage({
    projectId: towerProjectId,
    name: "Concept design",
    sortOrder: 0,
    startDate: isoDaysAgo(110),
    endDate: isoDaysAgo(70),
    status: "COMPLETED",
    completionBp: 10_000,
    engineers: null,
    notes: DEMO_NOTE,
  });
  await createStage({
    projectId: towerProjectId,
    name: "Detailed design",
    sortOrder: 1,
    startDate: isoDaysAgo(69),
    endDate: null,
    status: "IN_PROGRESS",
    completionBp: 5_500,
    engineers: null,
    notes: DEMO_NOTE,
  });

  // Certificate 1: collected in full — the payment allocation drives the
  // PAID status through the real evidence rules.
  const paidCertificateId = await createCertificate(1, {
    contractId: towerContractId,
    number: await reserveNextNumber("CERTIFICATE", "DEMOPC"),
    date: isoDaysAgo(60),
    submissionDate: isoDaysAgo(60),
    dueDateOverride: null,
    description: "Concept design stage",
    grossMinor: 300_000_00,
    discountMinor: 0,
    manualAdvanceRecoveryMinor: null,
    status: "APPROVED",
  });
  await createPayment({
    contractId: towerContractId,
    kind: "CERTIFICATE",
    number: await reserveNextNumber("PAYMENT", "DEMOPAY"),
    date: isoDaysAgo(35),
    amountMinor: 300_000_00,
    method: "BANK_TRANSFER",
    bank: "CIB",
    reference: DEMO_NOTE,
    notes: DEMO_NOTE,
  }, [{ certificateId: paidCertificateId, amountMinor: 300_000_00 }]);

  // Certificate 2: submitted 45 days ago on 30-day terms — genuinely overdue.
  await createCertificate(2, {
    contractId: towerContractId,
    number: await reserveNextNumber("CERTIFICATE", "DEMOPC"),
    date: isoDaysAgo(45),
    submissionDate: isoDaysAgo(45),
    dueDateOverride: null,
    description: "Detailed design — first interim",
    grossMinor: 200_000_00,
    discountMinor: 0,
    manualAdvanceRecoveryMinor: null,
    status: "SUBMITTED",
  });

  const resortProjectId = await createProject(await reserveNextNumber("PROJECT", "DEMO"), {
    name: `Coastal Resort — Electrical (${DEMO_TAG})`,
    clientId,
    country: "Egypt",
    city: "Hurghada",
    manager: "Sara El-Sayed",
    discipline: "ELECTRICAL",
    projectType: "Hospitality",
    status: "ACTIVE",
    currency: "USD",
    fxRateMicro: 48_500_000,
    startDate: isoDaysAgo(40),
    endDate: null,
    progressBp: 1_500,
    description: DEMO_NOTE,
  });
  refs.projectIds.push(resortProjectId);
  const resortContractId = await createContract({
    projectId: resortProjectId,
    number: await reserveNextNumber("CONTRACT", "DEMOC"),
    title: "Electrical design package",
    valueMinor: 40_000_00,
    vatBp: 1_400,
    retentionBp: 500,
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
    signedDate: isoDaysAgo(35),
    notes: DEMO_NOTE,
  });
  // Submitted 10 days ago on 30-day terms — an upcoming expected collection.
  await createCertificate(1, {
    contractId: resortContractId,
    number: await reserveNextNumber("CERTIFICATE", "DEMOPC"),
    date: isoDaysAgo(10),
    submissionDate: isoDaysAgo(10),
    dueDateOverride: null,
    description: "Preliminary electrical layouts",
    grossMinor: 12_000_00,
    discountMinor: 0,
    manualAdvanceRecoveryMinor: null,
    status: "SUBMITTED",
  });

  const categories = await listCategories();
  const categoryId = categories[0]?.id ?? 1;
  await createExpense({
    date: isoDaysAgo(40),
    categoryId,
    description: `Site survey — HQ tower (${DEMO_TAG})`,
    projectId: towerProjectId,
    supplier: "GeoSurvey Egypt",
    amountMinor: 18_500_00,
    currency: "EGP",
    fxRateMicro: 1_000_000,
    attachmentPath: null,
  });
  const overheadExpenseId = await createExpense({
    date: isoDaysAgo(5),
    categoryId,
    description: `Office rent (${DEMO_TAG})`,
    projectId: null,
    supplier: null,
    amountMinor: 35_000_00,
    currency: "EGP",
    fxRateMicro: 1_000_000,
    attachmentPath: null,
  });
  refs.overheadExpenseIds.push(overheadExpenseId);

  const personId = await createPerson({
    type: "EMPLOYEE",
    name: `Ahmed Hassan — ${DEMO_TAG}`,
    specialization: "Mechanical engineer",
    phone: null,
    email: null,
    bankAccount: null,
    hourlyRateMinor: 350_00,
    monthlyRateMinor: null,
    currency: "EGP",
    notes: DEMO_NOTE,
    isActive: true,
  });
  refs.personIds.push(personId);
  await createAssignment({
    personId,
    projectId: towerProjectId,
    agreedMinor: 60_000_00,
    currency: "EGP",
    fxRateMicro: 1_000_000,
    scope: "Mechanical design lead",
    progressNote: null,
  });
  await createTimeEntry({
    personId,
    projectId: towerProjectId,
    stageId: null,
    date: isoDaysAgo(20),
    minutes: 480,
    billable: true,
    note: DEMO_NOTE,
  });
  await createTimeEntry({
    personId,
    projectId: towerProjectId,
    stageId: null,
    date: isoDaysAgo(12),
    minutes: 360,
    billable: true,
    note: DEMO_NOTE,
  });
}

async function removeDemoRefs(refs: DemoWorkspaceRefs): Promise<void> {
  for (const projectId of refs.projectIds) await deleteProject(projectId);
  for (const clientId of refs.clientIds) await deleteClient(clientId);
  for (const personId of refs.personIds) await deletePerson(personId);
  for (const expenseId of refs.overheadExpenseIds) await deleteExpense(expenseId);
}

/**
 * Remove the demo workspace through normal lifecycle operations: projects,
 * client, and people are archived (which withdraws their certificates,
 * payments, expenses, and time from every operational surface) and the
 * overhead expense is voided. Nothing is hard-deleted, so the audit history
 * of the demo period stays reviewable.
 */
export async function removeDemoWorkspace(): Promise<void> {
  const settings = await loadSettings();
  const refs = parseDemoWorkspace(settings.demoWorkspace);
  if (!refs) throw new Error("DEMO_NOT_LOADED");
  await removeDemoRefs(refs);
  await saveSetting("demoWorkspace", "");
}

export function useDemoWorkspaceMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries();
  return {
    create: useMutation({ mutationFn: createDemoWorkspace, onSuccess: invalidate }),
    remove: useMutation({ mutationFn: removeDemoWorkspace, onSuccess: invalidate }),
  };
}
