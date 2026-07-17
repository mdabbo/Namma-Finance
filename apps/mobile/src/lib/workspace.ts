import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeContractState,
  computeDashboardKpis,
  computeProjectFinancials,
  computeReadyToBill,
  computeTeamPayout,
  parseMilestones,
  toEgpPiasters,
  type Contract,
  type ContractState,
  type DashboardKpis,
  type Expense,
  type Payment,
  type PaymentAllocation,
  type PaymentCertificate,
  type Project,
  type ProjectFinancials,
} from "@mep/core";

/**
 * Read-only mirror of the desktop's workspace financials, computed on the
 * phone from the Supabase tables with the SAME @mep/core engine — the two
 * apps can never disagree on a figure.
 *
 * Remote rows are keyed by uuid; @mep/core works with integer ids. Each
 * table gets synthetic ints (1, 2, 3… in fetch order) and every FK — plus
 * the certificate/stage refs inside contract milestone JSON — is remapped
 * through them. The ints live only in memory for one computation pass.
 */

const today = (): string => new Date().toISOString().slice(0, 10);

type Row = Record<string, unknown>;

async function fetchAll(client: SupabaseClient, table: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select("*")
      .is("deleted_at", null)
      .order("uuid")
      .range(rows.length, rows.length + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

class Ids {
  private map = new Map<string, number>();
  id(uuid: unknown): number {
    if (typeof uuid !== "string") return 0;
    let v = this.map.get(uuid);
    if (v === undefined) {
      v = this.map.size + 1;
      this.map.set(uuid, v);
    }
    return v;
  }
  idOrNull(uuid: unknown): number | null {
    return typeof uuid === "string" ? this.id(uuid) : null;
  }
}

export interface MobileAlertItem {
  key: string;
  projectName: string;
  projectCode: string;
  currency: string;
  titles: string[];
  amountMinor: number;
}

export interface TeamPayableAlert extends MobileAlertItem {
  personName: string;
}

export interface MobileWorkspace {
  projects: ProjectFinancials[];
  contractStates: Map<number, ContractState>;
  kpis: DashboardKpis;
  /** Per-currency face-value totals: [currency, {value, collected, outstanding}]. */
  byCurrency: [string, { value: number; collected: number; outstanding: number }][];
  readyToCollect: MobileAlertItem[];
  teamPayables: TeamPayableAlert[];
  overdueCount: number;
}

export async function loadMobileWorkspace(client: SupabaseClient): Promise<MobileWorkspace> {
  const [
    clientRows, projectRows, contractRows, certRows, paymentRows, allocRows,
    categoryRows, expenseRows, peopleRows, assignmentRows, personPaymentRows, stageRows,
  ] = await Promise.all([
    fetchAll(client, "clients"),
    fetchAll(client, "projects"),
    fetchAll(client, "contracts"),
    fetchAll(client, "payment_certificates"),
    fetchAll(client, "payments"),
    fetchAll(client, "payment_certificate_allocations"),
    fetchAll(client, "expense_categories"),
    fetchAll(client, "expenses"),
    fetchAll(client, "people"),
    fetchAll(client, "project_assignments"),
    fetchAll(client, "person_payments"),
    fetchAll(client, "project_stages"),
  ]);

  const ids = {
    clients: new Ids(), projects: new Ids(), contracts: new Ids(), certs: new Ids(),
    payments: new Ids(), categories: new Ids(), people: new Ids(), assignments: new Ids(),
    stages: new Ids(),
  };

  const clientNames = new Map<number, string>();
  for (const r of clientRows) clientNames.set(ids.clients.id(r.uuid), String(r.name ?? ""));

  const projects: Project[] = projectRows.map((r) => ({
    id: ids.projects.id(r.uuid),
    code: String(r.code ?? ""),
    name: String(r.name ?? ""),
    clientId: ids.clients.id(r.client_id),
    country: (r.country as string) ?? null,
    city: (r.city as string) ?? null,
    manager: (r.manager as string) ?? null,
    discipline: (r.discipline as Project["discipline"]) ?? "MULTI",
    projectType: (r.project_type as string) ?? null,
    status: (r.status as Project["status"]) ?? "ACTIVE",
    currency: String(r.currency ?? "EGP"),
    fxRateMicro: Number(r.fx_rate_micro ?? 1_000_000),
    startDate: (r.start_date as string) ?? null,
    endDate: (r.end_date as string) ?? null,
    progressBp: Number(r.progress_bp ?? 0),
    description: (r.description as string) ?? null,
    createdAt: String(r.created_at ?? ""),
  }));

  /** Contract milestone JSON travels with *Uuid refs remotely → remap to ints. */
  const remapMilestones = (json: unknown): string | null => {
    if (typeof json !== "string" || !json) return null;
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) return json;
      return JSON.stringify(
        arr.map((m: Row) => ({
          title: m.title ?? "",
          percentBp: m.percentBp ?? 0,
          done: m.done === true,
          stageId: ids.stages.idOrNull(m.stageUuid ?? null),
          certificateId: ids.certs.idOrNull(m.certificateUuid ?? null),
        })),
      );
    } catch {
      return json;
    }
  };

  const contracts: Contract[] = contractRows.map((r) => ({
    id: ids.contracts.id(r.uuid),
    projectId: ids.projects.id(r.project_id),
    number: String(r.number ?? ""),
    title: (r.title as string) ?? null,
    valueMinor: Number(r.value_minor ?? 0),
    vatBp: Number(r.vat_bp ?? 0),
    retentionBp: Number(r.retention_bp ?? 0),
    withholdingBp: Number(r.withholding_bp ?? 0),
    advanceMinor: Number(r.advance_minor ?? 0),
    advanceRecoveryMethod: (r.advance_recovery_method as Contract["advanceRecoveryMethod"]) ?? "PROPORTIONAL",
    performanceBondBp: Number(r.performance_bond_bp ?? 0),
    performanceBondBank: (r.performance_bond_bank as string) ?? null,
    performanceBondExpiry: (r.performance_bond_expiry as string) ?? null,
    paymentTermsDays: Number(r.payment_terms_days ?? 30),
    paymentTermsNotes: (r.payment_terms_notes as string) ?? null,
    valuationMode: (r.valuation_mode as Contract["valuationMode"]) ?? "LUMP_SUM",
    milestones: remapMilestones(r.milestones),
    drawings: (r.drawings as string) ?? null,
    attachments: null,
    signedDate: (r.signed_date as string) ?? null,
    notes: (r.notes as string) ?? null,
    createdAt: String(r.created_at ?? ""),
  }));

  const certificates: PaymentCertificate[] = certRows.map((r) => ({
    id: ids.certs.id(r.uuid),
    contractId: ids.contracts.id(r.contract_id),
    seq: Number(r.seq ?? 0),
    number: String(r.number ?? ""),
    date: String(r.date ?? ""),
    submissionDate: (r.submission_date as string) ?? null,
    dueDateOverride: (r.due_date_override as string) ?? null,
    description: (r.description as string) ?? null,
    grossMinor: Number(r.gross_minor ?? 0),
    discountMinor: Number(r.discount_minor ?? 0),
    manualAdvanceRecoveryMinor: r.manual_advance_recovery_minor == null ? null : Number(r.manual_advance_recovery_minor),
    status: (r.status as PaymentCertificate["status"]) ?? "DRAFT",
    deletedAt: (r.app_deleted_at as string) ?? null,
    createdAt: String(r.created_at ?? ""),
  }));

  const payments: Payment[] = paymentRows.map((r) => ({
    id: ids.payments.id(r.uuid),
    contractId: ids.contracts.id(r.contract_id),
    kind: (r.kind as Payment["kind"]) ?? "CERTIFICATE",
    number: String(r.number ?? ""),
    date: String(r.date ?? ""),
    amountMinor: Number(r.amount_minor ?? 0),
    method: (r.method as Payment["method"]) ?? "BANK_TRANSFER",
    bank: (r.bank as string) ?? null,
    reference: (r.reference as string) ?? null,
    notes: (r.notes as string) ?? null,
    deletedAt: (r.app_deleted_at as string) ?? null,
    createdAt: String(r.created_at ?? ""),
  }));

  const allocations: PaymentAllocation[] = allocRows.map((r, i) => ({
    id: i + 1,
    paymentId: ids.payments.id(r.payment_id),
    certificateId: ids.certs.id(r.certificate_id),
    amountMinor: Number(r.amount_minor ?? 0),
  }));

  const expenses: Expense[] = expenseRows.map((r, i) => ({
    id: i + 1,
    date: String(r.date ?? ""),
    categoryId: ids.categories.id(r.category_id),
    description: String(r.description ?? ""),
    projectId: ids.projects.idOrNull(r.project_id),
    supplier: (r.supplier as string) ?? null,
    amountMinor: Number(r.amount_minor ?? 0),
    currency: String(r.currency ?? "EGP"),
    fxRateMicro: Number(r.fx_rate_micro ?? 1_000_000),
    attachmentPath: null,
    createdAt: String(r.created_at ?? ""),
  }));

  const todayIso = today();
  const contractStates = new Map<number, ContractState>();
  for (const contract of contracts) {
    contractStates.set(
      contract.id,
      computeContractState({
        contract,
        certificates: certificates.filter((c) => c.contractId === contract.id),
        payments: payments.filter((p) => p.contractId === contract.id),
        allocations,
        todayIso,
      }),
    );
  }

  const projectFinancials = projects.map((project) =>
    computeProjectFinancials(
      project,
      contracts.filter((c) => c.projectId === project.id).map((c) => contractStates.get(c.id)!),
      expenses.filter((e) => e.projectId === project.id),
    ),
  );

  const kpis = computeDashboardKpis(projectFinancials, expenses);

  const byCurrencyMap = new Map<string, { value: number; collected: number; outstanding: number }>();
  for (const p of projectFinancials) {
    const g = byCurrencyMap.get(p.project.currency) ?? { value: 0, collected: 0, outstanding: 0 };
    g.value += p.contractValueMinor;
    g.collected += p.totalPaidMinor;
    g.outstanding += p.outstandingMinor;
    byCurrencyMap.set(p.project.currency, g);
  }

  // ready-to-collect: achieved milestones not certified yet
  const completedByProject = new Map<number, Set<number>>();
  for (const r of stageRows) {
    if (r.status === "COMPLETED") {
      const projectId = ids.projects.id(r.project_id);
      if (!completedByProject.has(projectId)) completedByProject.set(projectId, new Set());
      completedByProject.get(projectId)!.add(ids.stages.id(r.uuid));
    }
  }
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const readyToCollect: MobileAlertItem[] = [];
  for (const contract of contracts) {
    if (contract.valuationMode !== "MILESTONES") continue;
    const milestones = parseMilestones(contract.milestones);
    if (milestones.length === 0) continue;
    const project = projectById.get(contract.projectId);
    const state = contractStates.get(contract.id);
    if (!project || !state) continue;
    const ready = computeReadyToBill(
      contract.valueMinor,
      milestones,
      completedByProject.get(project.id) ?? new Set(),
      state.certifiedBaseMinor,
    );
    if (ready.readyMinor > 0) {
      readyToCollect.push({
        key: `rtc-${contract.id}`,
        projectName: project.name,
        projectCode: project.code,
        currency: project.currency,
        titles: ready.achievedTitles,
        amountMinor: ready.readyMinor,
      });
    }
  }

  // team payables: certificate paid → pay the matching stage to the person
  const personNames = new Map<number, string>();
  for (const r of peopleRows) personNames.set(ids.people.id(r.uuid), String(r.name ?? ""));
  const paidByAssignment = new Map<number, number>();
  for (const r of personPaymentRows) {
    const assignmentId = ids.assignments.id(r.assignment_id);
    paidByAssignment.set(assignmentId, (paidByAssignment.get(assignmentId) ?? 0) + Number(r.amount_minor ?? 0));
  }
  const statesByProject = new Map<number, ContractState[]>();
  for (const contract of contracts) {
    const list = statesByProject.get(contract.projectId) ?? [];
    list.push(contractStates.get(contract.id)!);
    statesByProject.set(contract.projectId, list);
  }
  const teamPayables: TeamPayableAlert[] = [];
  for (const r of assignmentRows) {
    const assignmentId = ids.assignments.id(r.uuid);
    const projectId = ids.projects.id(r.project_id);
    const project = projectById.get(projectId);
    if (!project) continue;
    const payout = computeTeamPayout(
      Number(r.agreed_minor ?? 0),
      statesByProject.get(projectId) ?? [],
      paidByAssignment.get(assignmentId) ?? 0,
    );
    if (payout.dueMinor > 0) {
      teamPayables.push({
        key: `tp-${assignmentId}`,
        personName: personNames.get(ids.people.id(r.person_id)) ?? "",
        projectName: project.name,
        projectCode: project.code,
        currency: String(r.currency ?? project.currency),
        titles: payout.dueTitles,
        amountMinor: payout.dueMinor,
      });
    }
  }

  return {
    projects: projectFinancials,
    contractStates,
    kpis,
    byCurrency: [...byCurrencyMap.entries()].sort(([a], [b]) => a.localeCompare(b)),
    readyToCollect,
    teamPayables,
    overdueCount: kpis.overdueCertificates,
  };
}

/** EGP-consolidated helper (mobile shows EGP totals + face-value per currency). */
export { toEgpPiasters };
