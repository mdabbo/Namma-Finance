import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A stand-in for the Supabase client that answers with made-up rows, so the
 * screens can be looked at in a browser (`EXPO_PUBLIC_PREVIEW=1 pnpm web`)
 * without a login or an office's real figures. It exists only for that: App.tsx
 * reaches it through a build-time flag, so it is not part of the installed app.
 *
 * Rows use the cloud's column names, so the real mapping in lib/workspace.ts
 * and the real @mep/core engine run on them.
 */

type Row = Record<string, unknown>;

const DAY = 86_400_000;
const iso = (offsetDays: number): string => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const money = (major: number): number => Math.round(major * 100);

const rows: Record<string, Row[]> = {
  clients: [
    { uuid: "cl-1", name: "Al Rawabi Development" },
    { uuid: "cl-2", name: "Nile Properties" },
    { uuid: "cl-3", name: "Gulf Healthcare Group" },
  ],
  projects: [],
  contracts: [],
  payment_certificates: [],
  payments: [],
  payment_certificate_allocations: [],
  expense_categories: [{ uuid: "cat-1", name_en: "Travel", name_ar: "سفر" }],
  expenses: [],
  people: [
    { uuid: "pe-1", name: "Omar Hassan" },
    { uuid: "pe-2", name: "Layla Mostafa" },
  ],
  project_assignments: [],
  person_payments: [],
  project_stages: [],
};

interface ProjectSeed {
  n: number;
  name: string;
  client: string;
  currency: "EGP" | "SAR" | "USD";
  fx: number; // EGP per major unit
  status: "ACTIVE" | "ON_HOLD" | "COMPLETED";
  value: number; // major units
  vat: number;
  /** [status, share of contract %, days ago, paid share of the net amount] */
  certs: ["DRAFT" | "SUBMITTED" | "APPROVED" | "PAID", number, number, number][];
}

const seeds: ProjectSeed[] = [
  { n: 101, name: "Al Narjis Villas — MEP design", client: "cl-1", currency: "SAR", fx: 12.8, status: "ACTIVE", value: 480_000, vat: 1500,
    certs: [["PAID", 30, 150, 1], ["PAID", 25, 95, 1], ["APPROVED", 20, 40, 0], ["DRAFT", 10, 5, 0]] },
  { n: 102, name: "Nile Corniche Tower", client: "cl-2", currency: "EGP", fx: 1, status: "ACTIVE", value: 12_500_000, vat: 1400,
    certs: [["PAID", 20, 120, 1], ["PAID", 20, 80, 1], ["SUBMITTED", 20, 52, 0]] },
  { n: 103, name: "Riyadh Medical Center", client: "cl-3", currency: "SAR", fx: 12.8, status: "ACTIVE", value: 1_150_000, vat: 1500,
    certs: [["PAID", 40, 70, 0.6], ["SUBMITTED", 25, 20, 0]] },
  { n: 104, name: "New Cairo Mall — HVAC", client: "cl-2", currency: "EGP", fx: 1, status: "ON_HOLD", value: 3_800_000, vat: 1400,
    certs: [["PAID", 30, 200, 1]] },
  { n: 105, name: "Jeddah Office Fit-out", client: "cl-1", currency: "SAR", fx: 12.8, status: "COMPLETED", value: 260_000, vat: 1500,
    certs: [["PAID", 50, 300, 1], ["PAID", 50, 210, 1]] },
  { n: 106, name: "Sheikh Zayed Compound", client: "cl-2", currency: "EGP", fx: 1, status: "ACTIVE", value: 6_900_000, vat: 1400,
    certs: [["PAID", 35, 60, 1], ["APPROVED", 15, 10, 0]] },
];

seeds.forEach((seed, index) => {
  const pid = `pr-${seed.n}`;
  const cid = `co-${seed.n}`;
  rows.projects!.push({
    uuid: pid, code: `P-${seed.n}`, name: seed.name, client_id: seed.client, currency: seed.currency,
    fx_rate_micro: Math.round(seed.fx * 1_000_000), status: seed.status, discipline: "MULTI", progress_bp: 0,
    created_at: iso(-400),
  });
  const milestoneProject = index === 5;
  rows.contracts!.push({
    uuid: cid, project_id: pid, number: `C-${seed.n}`, title: seed.name, value_minor: money(seed.value),
    vat_bp: seed.vat, retention_bp: 500, withholding_bp: 0, advance_minor: 0, advance_recovery_method: "PROPORTIONAL",
    payment_terms_days: 30, valuation_mode: milestoneProject ? "MILESTONES" : "LUMP_SUM",
    milestones: milestoneProject
      ? JSON.stringify([
          { title: "Concept design", percentBp: 3500, done: true, stageUuid: "st-1" },
          { title: "Detailed design", percentBp: 3000, done: false, stageUuid: "st-2" },
          { title: "Tender documents", percentBp: 2000, done: false, stageUuid: "st-3" },
        ])
      : null,
    signed_date: iso(-380), created_at: iso(-380),
  });
  seed.certs.forEach(([status, share, daysAgo, paidShare], i) => {
    const certId = `ce-${seed.n}-${i + 1}`;
    const gross = money((seed.value * share) / 100);
    rows.payment_certificates!.push({
      uuid: certId, contract_id: cid, seq: i + 1, number: `PC-${seed.n}-${String(i + 1).padStart(2, "0")}`,
      date: iso(-daysAgo), submission_date: iso(-daysAgo),
      description: ["Design stage", "Coordination stage", "Construction drawings", "Final submission"][i] ?? null,
      gross_minor: gross, discount_minor: 0, status, created_at: iso(-daysAgo),
    });
    if (paidShare > 0) {
      const net = Math.round(gross * (1 + seed.vat / 10_000) * 0.95);
      const paid = Math.round(net * paidShare);
      rows.payments!.push({
        uuid: `pa-${seed.n}-${i + 1}`, contract_id: cid, kind: "CERTIFICATE", number: `RC-${seed.n}-${i + 1}`,
        date: iso(-daysAgo + 20), amount_minor: paid, method: "BANK_TRANSFER", created_at: iso(-daysAgo + 20),
      });
      rows.payment_certificate_allocations!.push({
        uuid: `al-${seed.n}-${i + 1}`, payment_id: `pa-${seed.n}-${i + 1}`, certificate_id: certId, amount_minor: paid,
      });
    }
  });
});

rows.project_stages!.push(
  { uuid: "st-1", project_id: "pr-106", name: "Concept design", status: "COMPLETED" },
  { uuid: "st-2", project_id: "pr-106", name: "Detailed design", status: "IN_PROGRESS" },
  { uuid: "st-3", project_id: "pr-106", name: "Tender documents", status: "PLANNED" },
);
rows.expenses!.push(
  { uuid: "ex-1", date: iso(-12), category_id: "cat-1", description: "Site visit — Riyadh", project_id: "pr-103", amount_minor: money(4_200), currency: "SAR", fx_rate_micro: 12_800_000 },
  { uuid: "ex-2", date: iso(-30), category_id: "cat-1", description: "Printing and plotting", project_id: "pr-102", amount_minor: money(38_000), currency: "EGP", fx_rate_micro: 1_000_000 },
  { uuid: "ex-3", date: iso(-8), category_id: "cat-1", description: "Office rent", project_id: null, amount_minor: money(120_000), currency: "EGP", fx_rate_micro: 1_000_000 },
);
rows.project_assignments!.push(
  { uuid: "as-1", person_id: "pe-1", project_id: "pr-102", agreed_minor: money(900_000), currency: "EGP", fx_rate_micro: 1_000_000, lifecycle_status: "ACTIVE" },
  { uuid: "as-2", person_id: "pe-2", project_id: "pr-101", agreed_minor: money(60_000), currency: "SAR", fx_rate_micro: 12_800_000, lifecycle_status: "ACTIVE" },
);

type Result = { data: Row[] | null; error: null; count?: number };

class PreviewQuery implements PromiseLike<Result> {
  private from = 0;
  private to = 999;
  private head = false;
  constructor(private readonly table: string) {}
  select(_columns?: string, options?: { head?: boolean }): this { this.head = options?.head === true; return this; }
  is(): this { return this; }
  eq(): this { return this; }
  order(): this { return this; }
  /** The signed-in preview user is an admin. */
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.table === "user_roles" ? { role: "ADMIN" } : null, error: null };
  }
  range(from: number, to: number): this { this.from = from; this.to = to; return this; }
  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const all = rows[this.table] ?? [];
    const result: Result = this.head ? { data: null, error: null, count: all.length } : { data: all.slice(this.from, this.to + 1), error: null };
    return Promise.resolve<Result>(result).then(onfulfilled, onrejected);
  }
}

export function createPreviewClient(): SupabaseClient {
  const client = {
    from: (table: string) => new PreviewQuery(table),
    auth: {
      signOut: () => new Promise<never>(() => undefined), // stays on the screen being looked at
      getSession: async () => ({ data: { session: { user: { id: "preview", email: "preview@dabworks.test" } } } }),
      getUser: async () => ({ data: { user: { id: "preview", email: "preview@dabworks.test" } } }),
    },
  };
  return client as unknown as SupabaseClient;
}
