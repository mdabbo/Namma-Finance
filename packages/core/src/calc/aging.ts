/**
 * Receivables aging (Phase 2): unpaid billable certificates bucketed by how
 * far past due they are. Certificates without a due date count as "current".
 */

export interface AgingInput {
  certificateId: number;
  certificateNumber: string;
  projectName: string;
  clientName: string;
  dueDate: string | null;
  unpaidEgp: number;
}

export type AgingBucket = "CURRENT" | "D1_30" | "D31_60" | "D61_90" | "D90_PLUS";

export const AGING_BUCKETS: readonly AgingBucket[] = ["CURRENT", "D1_30", "D31_60", "D61_90", "D90_PLUS"];

export interface AgingRow extends AgingInput {
  bucket: AgingBucket;
  daysOverdue: number;
}

export interface AgingSummary {
  rows: AgingRow[];
  totals: Record<AgingBucket, number>;
  grandTotal: number;
}

function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const from = Date.UTC(fy!, fm! - 1, fd!);
  const to = Date.UTC(ty!, tm! - 1, td!);
  return Math.round((to - from) / 86_400_000);
}

export function bucketFor(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "CURRENT";
  if (daysOverdue <= 30) return "D1_30";
  if (daysOverdue <= 60) return "D31_60";
  if (daysOverdue <= 90) return "D61_90";
  return "D90_PLUS";
}

export function computeAging(items: AgingInput[], todayIso: string): AgingSummary {
  const totals: Record<AgingBucket, number> = { CURRENT: 0, D1_30: 0, D31_60: 0, D61_90: 0, D90_PLUS: 0 };
  const rows: AgingRow[] = [];
  for (const item of items) {
    if (item.unpaidEgp <= 0) continue;
    const daysOverdue = item.dueDate ? daysBetween(item.dueDate, todayIso) : 0;
    const bucket = bucketFor(daysOverdue);
    totals[bucket] += item.unpaidEgp;
    rows.push({ ...item, bucket, daysOverdue: Math.max(0, daysOverdue) });
  }
  rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return { rows, totals, grandTotal: rows.reduce((s, r) => s + r.unpaidEgp, 0) };
}
