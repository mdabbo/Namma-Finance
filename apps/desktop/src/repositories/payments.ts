import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Payment, PaymentAllocation, PaymentInput } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";
import { withLock } from "../lib/mutex";

export interface PaymentRow {
  id: number;
  contract_id: number;
  kind: Payment["kind"];
  number: string;
  date: string;
  amount_minor: number;
  method: Payment["method"];
  bank: string | null;
  reference: string | null;
  notes: string | null;
  deleted_at: string | null;
  created_at: string;
  contract_number?: string;
  project_id?: number;
  project_name?: string;
  project_code?: string;
  currency?: string;
  client_name?: string;
  allocated_minor?: number;
}

export interface PaymentListItem extends Payment {
  contractNumber: string;
  projectId: number;
  projectName: string;
  projectCode: string;
  currency: string;
  clientName: string;
  allocatedMinor: number;
}

export function mapPayment(r: PaymentRow): PaymentListItem {
  return {
    id: r.id,
    contractId: r.contract_id,
    kind: r.kind,
    number: r.number,
    date: r.date,
    amountMinor: r.amount_minor,
    method: r.method,
    bank: r.bank,
    reference: r.reference,
    notes: r.notes,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
    contractNumber: r.contract_number ?? "",
    projectId: r.project_id ?? 0,
    projectName: r.project_name ?? "",
    projectCode: r.project_code ?? "",
    currency: r.currency ?? "EGP",
    clientName: r.client_name ?? "",
    allocatedMinor: r.allocated_minor ?? 0,
  };
}

const LIST_SQL = `
  SELECT pm.*, ct.number AS contract_number, p.id AS project_id, p.name AS project_name,
         p.code AS project_code, p.currency AS currency, cl.name AS client_name,
         COALESCE((SELECT SUM(a.amount_minor) FROM payment_certificate_allocations a WHERE a.payment_id = pm.id), 0) AS allocated_minor
  FROM payments pm
  JOIN contracts ct ON ct.id = pm.contract_id
  JOIN projects p ON p.id = ct.project_id
  JOIN clients cl ON cl.id = p.client_id
  WHERE pm.deleted_at IS NULL`;

export async function listPayments(): Promise<PaymentListItem[]> {
  const rows = await select<PaymentRow>(`${LIST_SQL} ORDER BY pm.date DESC, pm.id DESC`);
  return rows.map(mapPayment);
}

export async function listPaymentsByContract(contractId: number): Promise<PaymentListItem[]> {
  const rows = await select<PaymentRow>(`${LIST_SQL} AND pm.contract_id = $1 ORDER BY pm.date, pm.id`, [contractId]);
  return rows.map(mapPayment);
}

export async function getPayment(id: number): Promise<PaymentListItem | null> {
  const row = await selectOne<PaymentRow>(`${LIST_SQL} AND pm.id = $1`, [id]);
  return row ? mapPayment(row) : null;
}

export async function listAllocationsByContract(contractId: number): Promise<PaymentAllocation[]> {
  return select<PaymentAllocation & { paymentId: number; certificateId: number; amountMinor: number }>(
    `SELECT a.id, a.payment_id AS paymentId, a.certificate_id AS certificateId, a.amount_minor AS amountMinor
     FROM payment_certificate_allocations a
     JOIN payments pm ON pm.id = a.payment_id
     WHERE pm.contract_id = $1 AND pm.deleted_at IS NULL`,
    [contractId],
  );
}

export async function listAllocationsByPayment(paymentId: number) {
  return select<{ id: number; certificateId: number; certificateNumber: string; amountMinor: number }>(
    `SELECT a.id, a.certificate_id AS certificateId, pc.number AS certificateNumber, a.amount_minor AS amountMinor
     FROM payment_certificate_allocations a
     JOIN payment_certificates pc ON pc.id = a.certificate_id
     WHERE a.payment_id = $1`,
    [paymentId],
  );
}

export interface AllocationInput {
  certificateId: number;
  amountMinor: number;
}

/**
 * A certificate whose unpaid balance reaches zero is promoted to PAID
 * automatically — "Paid" always means "fully collected", never just a label.
 */
export async function promoteFullyPaidCertificates(certificateIds: number[]): Promise<void> {
  const unique = [...new Set(certificateIds)];
  if (unique.length === 0) return;
  const { loadWorkspaceFinancials } = await import("./financials");
  const ws = await loadWorkspaceFinancials();
  for (const state of ws.contractStates.values()) {
    for (const cs of state.certificates) {
      if (
        unique.includes(cs.certificate.id) &&
        cs.unpaidMinor <= 0 &&
        cs.certificate.status !== "PAID" &&
        cs.certificate.status !== "DRAFT"
      ) {
        await execute("UPDATE payment_certificates SET status='PAID' WHERE id=$1", [cs.certificate.id]);
      }
    }
  }
}

/**
 * The inverse guarantee of `promoteFullyPaidCertificates`: any certificate
 * whose status says PAID but whose collected money doesn't cover it gets an
 * auto-created backing payment for the shortfall. This is what makes
 * "Collected" always agree with what the user asserted — whether they used
 * the Mark-paid button, the status dropdown in the certificate form, or an
 * import. Runs for specific certificates after saves, and for everything at
 * app startup (heals data created before this rule existed). Idempotent.
 */
export function backPaidCertificatesWithPayments(onlyIds?: number[]): Promise<number> {
  return withLock(() => backPaidImpl(onlyIds));
}

async function backPaidImpl(onlyIds?: number[]): Promise<number> {
  const { loadWorkspaceFinancials } = await import("./financials");
  const { todayIso } = await import("../lib/format");
  const ws = await loadWorkspaceFinancials();
  let created = 0;
  for (const state of ws.contractStates.values()) {
    for (const cs of state.certificates) {
      if (cs.certificate.status !== "PAID" || cs.unpaidMinor <= 0) continue;
      if (onlyIds && !onlyIds.includes(cs.certificate.id)) continue;
      await createPayment(
        {
          contractId: state.contract.id,
          kind: "CERTIFICATE",
          number: `PAY-${cs.certificate.number}`,
          date: todayIso(),
          amountMinor: cs.unpaidMinor,
          method: "BANK_TRANSFER",
          bank: null,
          reference: null,
          notes: null,
        },
        [{ certificateId: cs.certificate.id, amountMinor: cs.unpaidMinor }],
      );
      created += 1;
    }
  }
  return created;
}

/**
 * Heal payments that carry unallocated money (recorded before auto-allocation
 * existed, or deliberately left unsplit): allocate the remainder to the
 * contract's open certificates oldest-first. This is what makes "outstanding
 * receivables" and "remaining balance" agree with the cash actually received.
 */
export function allocateUnallocatedPayments(): Promise<number> {
  return withLock(() => allocateUnallocatedImpl());
}

async function allocateUnallocatedImpl(): Promise<number> {
  const { loadWorkspaceFinancials } = await import("./financials");
  const { suggestAllocation } = await import("@mep/core");
  const ws = await loadWorkspaceFinancials();
  let healed = 0;
  for (const state of ws.contractStates.values()) {
    const contractPayments = await select<PaymentRow>(
      `SELECT pm.*, COALESCE((SELECT SUM(a.amount_minor) FROM payment_certificate_allocations a WHERE a.payment_id = pm.id), 0) AS allocated_minor
       FROM payments pm WHERE pm.contract_id = $1 AND pm.deleted_at IS NULL AND pm.kind = 'CERTIFICATE'`,
      [state.contract.id],
    );
    // track evolving unpaid balances as we allocate payment after payment
    const open = state.certificates
      .filter((cs) => cs.certificate.status !== "DRAFT")
      .map((cs) => ({ certificateId: cs.certificate.id, unpaidMinor: cs.unpaidMinor }));
    for (const payment of contractPayments) {
      const remainder = payment.amount_minor - (payment.allocated_minor ?? 0);
      if (remainder <= 0) continue;
      const { allocations } = suggestAllocation(remainder, open);
      for (const a of allocations) {
        await execute(
          "INSERT INTO payment_certificate_allocations (payment_id, certificate_id, amount_minor) VALUES ($1,$2,$3)",
          [payment.id, a.certificateId, a.amountMinor],
        );
        const slot = open.find((o) => o.certificateId === a.certificateId);
        if (slot) slot.unpaidMinor -= a.amountMinor;
        healed += 1;
      }
    }
    if (healed > 0) {
      await promoteFullyPaidCertificates(open.map((o) => o.certificateId));
    }
  }
  return healed;
}

export async function createPayment(input: PaymentInput, allocations: AllocationInput[]): Promise<number> {
  const r = await execute(
    `INSERT INTO payments (contract_id, kind, number, date, amount_minor, method, bank, reference, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.contractId, input.kind, input.number, input.date, input.amountMinor, input.method,
     input.bank ?? null, input.reference ?? null, input.notes ?? null],
  );
  const paymentId = r.lastInsertId ?? 0;
  for (const a of allocations) {
    await execute(
      "INSERT INTO payment_certificate_allocations (payment_id, certificate_id, amount_minor) VALUES ($1,$2,$3)",
      [paymentId, a.certificateId, a.amountMinor],
    );
  }
  await promoteFullyPaidCertificates(allocations.map((a) => a.certificateId));
  return paymentId;
}

export async function updatePayment(id: number, input: PaymentInput, allocations: AllocationInput[]): Promise<void> {
  await execute(
    `UPDATE payments SET kind=$1, number=$2, date=$3, amount_minor=$4, method=$5, bank=$6, reference=$7, notes=$8
     WHERE id=$9`,
    [input.kind, input.number, input.date, input.amountMinor, input.method,
     input.bank ?? null, input.reference ?? null, input.notes ?? null, id],
  );
  await execute("DELETE FROM payment_certificate_allocations WHERE payment_id = $1", [id]);
  for (const a of allocations) {
    await execute(
      "INSERT INTO payment_certificate_allocations (payment_id, certificate_id, amount_minor) VALUES ($1,$2,$3)",
      [id, a.certificateId, a.amountMinor],
    );
  }
  await promoteFullyPaidCertificates(allocations.map((a) => a.certificateId));
}

/** Soft delete — history matters for payments. Allocations of deleted payments are ignored by calc. */
export async function deletePayment(id: number): Promise<void> {
  await execute("UPDATE payments SET deleted_at = datetime('now') WHERE id = $1", [id]);
}

export function usePayments() {
  return useQuery({ queryKey: ["payments"], queryFn: listPayments });
}
export function usePaymentsByContract(contractId: number) {
  return useQuery({ queryKey: ["payments", "contract", contractId], queryFn: () => listPaymentsByContract(contractId) });
}
export function usePaymentAllocations(paymentId: number) {
  return useQuery({ queryKey: ["payments", paymentId, "allocations"], queryFn: () => listAllocationsByPayment(paymentId) });
}

export function usePaymentMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["payments"] });
    void qc.invalidateQueries({ queryKey: ["certificates"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
  };
  return {
    create: useMutation({
      mutationFn: (v: { input: PaymentInput; allocations: AllocationInput[] }) =>
        createPayment(v.input, v.allocations),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (v: { id: number; input: PaymentInput; allocations: AllocationInput[] }) =>
        updatePayment(v.id, v.input, v.allocations),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deletePayment, onSuccess: invalidate }),
  };
}
