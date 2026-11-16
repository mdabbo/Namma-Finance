import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Cloud row-level-security tests (plan step F0, delta A).
 *
 * Runs the REAL docs/supabase-*.sql scripts, unmodified and in their apply
 * order, in an embedded Postgres, then signs in as each role and tries the
 * writes. The phone talks to Supabase directly, so what an engineer login can
 * and cannot write is decided here and nowhere else — these tests are the
 * proof the mobile plan asks for (DEVELOPMENT-PLAN.md 11.4).
 *
 * Only the Supabase-provided pieces are stubbed: the roles, auth.users,
 * auth.uid() (reads the same request.jwt.claims setting PostgREST sets) and
 * the storage schema.
 */

const docs = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), "utf8");

const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
$$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`;

/** docs/PHASE3-SETUP.md apply order (repair-only and optional scripts omitted). */
const APPLY_ORDER = [
  "supabase-schema.sql",
  "supabase-roles.sql",
  "supabase-0007-time-entries.sql",
  "supabase-0008-financial-lifecycle.sql",
  "supabase-0009-contract-revisions.sql",
  "supabase-0010-contract-revision-integrity.sql",
  "supabase-0011-payment-allocation-integrity.sql",
  "supabase-security-hardening.sql",
  "supabase-0012-domain-validation.sql",
  "supabase-0013-managed-documents.sql",
  "supabase-0014-numbering-safety.sql",
  "supabase-0015-contract-sync-security.sql",
  "supabase-0019-special-person-payments.sql",
  "supabase-0020-stage-progress-log.sql",
];
const DELTA = "supabase-0021-time-entry-capture.sql";

/** Tables the plan lists as desktop-only: an engineer login must not write them. */
const DESKTOP_ONLY_TABLES = [
  "clients", "people", "expense_categories", "projects", "contracts", "contract_revisions",
  "variation_orders", "project_assignments", "payment_certificates", "payments",
  "payment_certificate_allocations", "person_payments", "expenses", "recurring_expenses",
];

const U = {
  admin: "a0000000-0000-4000-8000-000000000001",
  accountant: "a0000000-0000-4000-8000-000000000002",
  engineerA: "a0000000-0000-4000-8000-000000000003",
  engineerB: "a0000000-0000-4000-8000-000000000004",
  unlinked: "a0000000-0000-4000-8000-000000000005", // ENGINEER role, no person
  outsider: "a0000000-0000-4000-8000-000000000006", // a login with no role row
  newcomer: "a0000000-0000-4000-8000-000000000007", // a login awaiting a role
};
const P = {
  a: "b0000000-0000-4000-8000-000000000001",
  b: "b0000000-0000-4000-8000-000000000002",
  free: "b0000000-0000-4000-8000-000000000003",
};
const CLIENT = "c0000000-0000-4000-8000-000000000001";
const PROJECT = "d0000000-0000-4000-8000-000000000001";
const PROJECT_OTHER = "d0000000-0000-4000-8000-000000000002";
const PROJECT_DELETED = "d0000000-0000-4000-8000-000000000003";
const STAGE = "e0000000-0000-4000-8000-000000000001";
const STAGE_OTHER = "e0000000-0000-4000-8000-000000000002";
const CATEGORY = "f0000000-0000-4000-8000-000000000001";

let seq = 0;
const newUuid = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** YYYY-MM-DD, `offset` days from today in UTC — the clock the server rule uses. */
function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

type Outcome =
  | { ok: true; rows: Record<string, unknown>[]; affected: number }
  | { ok: false; error: string };

let db: PGlite;

/** Run one statement as a signed-in login, the way PostgREST would. */
async function as(user: string | null, sql: string, params: unknown[] = []): Promise<Outcome> {
  await db.exec("begin");
  try {
    if (user === null) {
      await db.exec("set local role anon");
    } else {
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: user, role: "authenticated" }),
      ]);
    }
    const result = await db.query<Record<string, unknown>>(sql, params);
    await db.exec("commit");
    return { ok: true, rows: result.rows, affected: result.affectedRows ?? 0 };
  } catch (error) {
    await db.exec("rollback");
    return { ok: false, error: (error as Error).message };
  }
}

/** Direct access with no login: the SQL editor / service path. */
async function root<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

interface EntryInput {
  uuid?: string;
  person?: string;
  project?: string;
  stage?: string | null;
  date?: string;
  minutes?: number;
  billable?: number;
  updatedAt?: string;
}

function insertEntry(user: string | null, e: EntryInput = {}): Promise<Outcome> {
  return as(
    user,
    `insert into time_entries (uuid, person_id, project_id, stage_id, date, minutes, billable, note, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,'site visit','2026-01-01 08:00:00',$8) returning uuid, updated_at`,
    [
      e.uuid ?? newUuid(), e.person ?? P.a, e.project ?? PROJECT, e.stage ?? null,
      e.date ?? day(0), e.minutes ?? 90, e.billable ?? 1, e.updatedAt ?? new Date().toISOString(),
    ],
  );
}

/** Seed an entry with no login, bypassing the capture rules (as a desktop push would). */
async function seedEntry(person: string, date: string, updatedAt = "2026-01-01T00:00:00.000Z"): Promise<string> {
  const uuid = newUuid();
  await root(
    `insert into time_entries (uuid, person_id, project_id, date, minutes, billable, created_at, updated_at)
     values ($1,$2,$3,$4,60,1,'2026-01-01 08:00:00',$5)`,
    [uuid, person, PROJECT, date, updatedAt],
  );
  return uuid;
}

async function entry(uuid: string): Promise<Record<string, unknown> | undefined> {
  return (await root("select * from time_entries where uuid=$1", [uuid]))[0];
}

function expectRejected(outcome: Outcome, reason: RegExp): void {
  expect(outcome.ok, outcome.ok ? "the write was accepted" : outcome.error).toBe(false);
  if (!outcome.ok) expect(outcome.error).toMatch(reason);
}

function expectAccepted(outcome: Outcome): asserts outcome is Extract<Outcome, { ok: true }> {
  expect(outcome.ok, outcome.ok ? "" : outcome.error).toBe(true);
}

const RLS = /row-level security/;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const file of APPLY_ORDER) await db.exec(docs(file));
  await db.exec(docs(DELTA));

  for (const [name, id] of Object.entries(U)) {
    await root("insert into auth.users (id, email) values ($1,$2)", [id, `${name}@office.test`]);
  }
  for (const [name, id] of Object.entries(P)) {
    await root(
      "insert into people (uuid, name, hourly_rate_minor, updated_at) values ($1,$2,5000,now())",
      [id, `Person ${name}`],
    );
  }
  const roles: [string, string, string | null][] = [
    [U.admin, "ADMIN", null],
    [U.accountant, "ACCOUNTANT", null],
    [U.engineerA, "ENGINEER", P.a],
    [U.engineerB, "ENGINEER", P.b],
    [U.unlinked, "ENGINEER", null],
  ];
  for (const [user, role, person] of roles) {
    await root(
      "insert into user_roles (user_id, email, role, person_id) select id, email, $2, $3 from auth.users where id=$1",
      [user, role, person],
    );
  }
  await root("insert into clients (uuid, name, updated_at) values ($1,'Client',now())", [CLIENT]);
  await root("insert into expense_categories (uuid, name_en, name_ar, updated_at) values ($1,'Site','موقع',now())", [CATEGORY]);
  for (const [uuid, code, deleted] of [
    [PROJECT, "P-1", null], [PROJECT_OTHER, "P-2", null], [PROJECT_DELETED, "P-3", "2026-01-01T00:00:00Z"],
  ] as const) {
    await root(
      "insert into projects (uuid, code, name, client_id, updated_at, deleted_at) values ($1,$2,$2,$3,now(),$4)",
      [uuid, code, CLIENT, deleted],
    );
  }
  await root("insert into project_stages (uuid, project_id, name, updated_at) values ($1,$2,'Design',now())", [STAGE, PROJECT]);
  await root("insert into project_stages (uuid, project_id, name, updated_at) values ($1,$2,'Design',now())", [STAGE_OTHER, PROJECT_OTHER]);
}, 120_000);

describe("the scripts themselves", () => {
  it("leave time_entries with the live policies plus the two own-entry policies", async () => {
    const rows = await root<{ policyname: string; cmd: string }>(
      "select policyname, cmd from pg_policies where schemaname='public' and tablename='time_entries' order by policyname",
    );
    expect(rows).toEqual([
      { policyname: "namaa_finance_write", cmd: "ALL" },
      { policyname: "namaa_member_read", cmd: "SELECT" },
      { policyname: "namaa_self_time_insert", cmd: "INSERT" },
      { policyname: "namaa_self_time_update", cmd: "UPDATE" },
    ]);
  });

  it("can be applied twice", async () => {
    await db.exec(docs(DELTA));
    const [{ n }] = await root<{ n: number }>(
      "select count(*)::int as n from pg_policies where schemaname='public' and tablename='time_entries'",
    );
    expect(n).toBe(4);
    const triggers = await root<{ tgname: string }>(
      "select tgname from pg_trigger where tgrelid='public.time_entries'::regclass and not tgisinternal order by tgname",
    );
    // Name order is firing order: the guard must come before the LWW guard.
    expect(triggers.map((t) => t.tgname)).toEqual(["trg_time_entries_capture_guard", "trg_time_entries_lww"]);
  });

  it("refuse to run while time_entries still has the open office_all policy", async () => {
    await db.exec("create policy office_all on public.time_entries for all to authenticated using (true) with check (true)");
    try {
      await expect(db.exec(docs(DELTA))).rejects.toThrow(/PREREQUISITE_MISSING/);
    } finally {
      await db.exec("drop policy office_all on public.time_entries");
    }
  });

  it("report ready in the read-only preflight", async () => {
    const [row] = await root<{ dabworks_0021_preflight: Record<string, unknown> }>(docs("supabase-0021-preflight.sql"));
    expect(row.dabworks_0021_preflight).toMatchObject({
      ready: true,
      person_link_column: true,
      capture_guard_trigger: true,
      time_entries_open_office_all: false,
    });
  });
});

describe("the policy inspection script", () => {
  it("runs read-only and reports the link and no open tables", async () => {
    const [row] = await root<{ dabworks_cloud_policies: Record<string, unknown> }>(docs("supabase-policy-preflight.sql"));
    expect(row.dabworks_cloud_policies).toMatchObject({
      user_roles_person_link: true,
      tables_with_open_office_all: [],
      tables_without_rls: [],
    });
    expect(Number(row.dabworks_cloud_policies.logins_linked_to_a_person)).toBeGreaterThanOrEqual(2);
  });
});

describe("an engineer's own time entries", () => {
  it("can be added, and the server sets updated_at whatever the phone sent", async () => {
    const outcome = await insertEntry(U.engineerA, { updatedAt: "2001-01-01T00:00:00.000Z" });
    expectAccepted(outcome);
    const stored = new Date(outcome.rows[0].updated_at as string).getTime();
    expect(Math.abs(Date.now() - stored)).toBeLessThan(60_000);
  });

  it("cannot be added for another person", async () => {
    expectRejected(await insertEntry(U.engineerA, { person: P.b }), /TIME_ENTRY_NOT_OWN/);
  });

  it("are refused by the policy even with the guard trigger switched off", async () => {
    await db.exec("alter table time_entries disable trigger trg_time_entries_capture_guard");
    try {
      expectRejected(await insertEntry(U.engineerA, { person: P.b }), RLS);
      const mine = await seedEntry(P.b, day(0));
      const stolen = await as(U.engineerA, "update time_entries set minutes=1, updated_at=now() where uuid=$1", [mine]);
      expectAccepted(stolen);
      expect(stolen.affected).toBe(0);
      // WITH CHECK on update: an own entry cannot be turned into someone else's.
      const own = await seedEntry(P.a, day(0));
      expectRejected(
        await as(U.engineerA, "update time_entries set person_id=$2, updated_at=now() where uuid=$1", [own, P.b]),
        RLS,
      );
      expect((await entry(own))!.person_id).toBe(P.a);
    } finally {
      await db.exec("alter table time_entries enable trigger trg_time_entries_capture_guard");
    }
  });

  it("cannot be added by an engineer login with no linked person, or a login with no role", async () => {
    expectRejected(await insertEntry(U.unlinked, { person: P.free }), /TIME_ENTRY_NOT_OWN/);
    expectRejected(await insertEntry(U.outsider, { person: P.a }), /TIME_ENTRY_NOT_OWN/);
    expectRejected(await insertEntry(null, { person: P.a }), /./);
  });

  it("can be edited, and the edit wins even when the phone's clock is behind", async () => {
    const uuid = await seedEntry(P.a, day(-1), new Date(Date.now() + 3_600_000).toISOString());
    const before = new Date((await entry(uuid))!.updated_at as string).getTime();
    const outcome = await as(
      U.engineerA,
      "update time_entries set minutes=45, updated_at='2001-01-01T00:00:00Z' where uuid=$1",
      [uuid],
    );
    expectAccepted(outcome);
    const after = (await entry(uuid))!;
    expect(after.minutes).toBe(45);
    expect(new Date(after.updated_at as string).getTime()).toBeGreaterThan(before);
  });

  it("can be withdrawn with a soft delete but never hard-deleted", async () => {
    const uuid = await seedEntry(P.a, day(0));
    const hard = await as(U.engineerA, "delete from time_entries where uuid=$1", [uuid]);
    expectAccepted(hard);
    expect(hard.affected).toBe(0);
    expect(await entry(uuid)).toBeDefined();

    expectAccepted(await as(U.engineerA, "update time_entries set deleted_at=now() where uuid=$1", [uuid]));
    expect((await entry(uuid))!.deleted_at).not.toBeNull();
  });

  it("cannot be handed to another person or have their identity changed", async () => {
    const uuid = await seedEntry(P.a, day(0));
    expectRejected(await as(U.engineerA, "update time_entries set person_id=$2 where uuid=$1", [uuid, P.b]), /TIME_ENTRY_NOT_OWN/);
    expectRejected(await as(U.engineerA, "update time_entries set created_at='2020-01-01' where uuid=$1", [uuid]), /TIME_ENTRY_IMMUTABLE_FIELD/);
    expectRejected(await as(U.engineerA, "update time_entries set uuid=$2 where uuid=$1", [uuid, newUuid()]), /TIME_ENTRY_IMMUTABLE_FIELD/);
    expect((await entry(uuid))!.person_id).toBe(P.a);
  });

  it("leave another engineer's entries untouched", async () => {
    const uuid = await seedEntry(P.b, day(0));
    const outcome = await as(U.engineerA, "update time_entries set minutes=1 where uuid=$1", [uuid]);
    expectAccepted(outcome);
    expect(outcome.affected).toBe(0);
    expect((await entry(uuid))!.minutes).toBe(60);
  });
});

describe("the 14-day window", () => {
  it("accepts 14 days back and one day ahead", async () => {
    expectAccepted(await insertEntry(U.engineerA, { date: day(-14) }));
    expectAccepted(await insertEntry(U.engineerA, { date: day(1) }));
  });

  it("locks anything older or further ahead", async () => {
    expectRejected(await insertEntry(U.engineerA, { date: day(-15) }), /TIME_ENTRY_LOCKED/);
    expectRejected(await insertEntry(U.engineerA, { date: day(2) }), /TIME_ENTRY_LOCKED/);
  });

  it("locks an old entry against edits, including moving it into the window", async () => {
    const uuid = await seedEntry(P.a, day(-20));
    expectRejected(await as(U.engineerA, "update time_entries set minutes=5 where uuid=$1", [uuid]), /TIME_ENTRY_LOCKED/);
    expectRejected(await as(U.engineerA, "update time_entries set date=$2 where uuid=$1", [uuid, day(0)]), /TIME_ENTRY_LOCKED/);
    expectRejected(await as(U.engineerA, "update time_entries set deleted_at=now() where uuid=$1", [uuid]), /TIME_ENTRY_LOCKED/);
    expect((await entry(uuid))!.minutes).toBe(60);
  });

  it("stops a current entry being moved out of the window", async () => {
    const uuid = await seedEntry(P.a, day(0));
    expectRejected(await as(U.engineerA, "update time_entries set date=$2 where uuid=$1", [uuid, day(-30)]), /TIME_ENTRY_LOCKED/);
  });
});

describe("field rules, with a reason the phone can show", () => {
  it.each([
    ["a date that does not exist", { date: `${day(0).slice(0, 4)}-02-30` }, /TIME_ENTRY_INVALID_DATE/],
    ["a date in another format", { date: "01/02/2026" }, /TIME_ENTRY_INVALID_DATE/],
    ["zero minutes", { minutes: 0 }, /TIME_ENTRY_INVALID_MINUTES/],
    ["more than 1000 hours", { minutes: 60_001 }, /TIME_ENTRY_INVALID_MINUTES/],
    ["a billable flag that is not 0 or 1", { billable: 2 }, /TIME_ENTRY_INVALID_BILLABLE/],
    ["a deleted project", { project: PROJECT_DELETED }, /TIME_ENTRY_PROJECT_UNAVAILABLE/],
    ["a stage from another project", { stage: STAGE_OTHER }, /TIME_ENTRY_STAGE_MISMATCH/],
  ] as const)("rejects %s", async (_label, input, reason) => {
    expectRejected(await insertEntry(U.engineerA, input), reason);
  });

  it("accepts the largest allowed entry and a stage of the same project", async () => {
    expectAccepted(await insertEntry(U.engineerA, { minutes: 60_000, stage: STAGE, billable: 0 }));
  });
});

describe("what an engineer login cannot write", () => {
  it("has no write policy on any desktop-only table", async () => {
    const rows = await root<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }>(
      "select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public' and tablename = any($1)",
      [DESKTOP_ONLY_TABLES],
    );
    for (const table of DESKTOP_ONLY_TABLES) {
      const policies = rows.filter((r) => r.tablename === table);
      expect(policies.map((p) => p.policyname).sort(), table).toEqual(["namaa_finance_write", "namaa_member_read"]);
      const write = policies.find((p) => p.policyname === "namaa_finance_write")!;
      expect(write.qual, table).toBe("nf_can_manage_finance()");
      expect(write.with_check, table).toBe("nf_can_manage_finance()");
      expect(policies.find((p) => p.policyname === "namaa_member_read")!.cmd, table).toBe("SELECT");
    }
    const check = await as(U.engineerA, "select nf_can_manage_finance() as finance, nf_is_member() as member");
    expectAccepted(check);
    expect(check.rows[0]).toEqual({ finance: false, member: true });
  });

  it.each(DESKTOP_ONLY_TABLES)("is refused an insert into %s", async (table) => {
    expectRejected(await as(U.engineerA, `insert into ${table} default values`), RLS);
  });

  it("cannot change or remove existing master and financial rows", async () => {
    for (const [table, uuid] of [["clients", CLIENT], ["people", P.b], ["projects", PROJECT], ["expense_categories", CATEGORY]] as const) {
      const update = await as(U.engineerA, `update ${table} set updated_at=now() where uuid=$1`, [uuid]);
      expectAccepted(update);
      expect(update.affected, table).toBe(0);
      const remove = await as(U.engineerA, `delete from ${table} where uuid=$1`, [uuid]);
      expectAccepted(remove);
      expect(remove.affected, table).toBe(0);
    }
    const rate = await as(U.engineerA, "update people set hourly_rate_minor=999999 where uuid=$1", [P.a]);
    expectAccepted(rate);
    expect(rate.affected).toBe(0);
  });

  it("cannot change its own role or its own person link", async () => {
    const promote = await as(U.engineerA, "update user_roles set role='ADMIN' where user_id=$1", [U.engineerA]);
    expectAccepted(promote);
    expect(promote.affected).toBe(0);
    const relink = await as(U.engineerA, "update user_roles set person_id=$2 where user_id=$1", [U.engineerA, P.free]);
    expectAccepted(relink);
    expect(relink.affected).toBe(0);
    expectRejected(
      await as(U.engineerA, "insert into user_roles (user_id, email, role) values ($1,'x@office.test','ADMIN')", [U.outsider]),
      RLS,
    );
  });
});

describe("giving a login a role", () => {
  it("is refused to anyone but an admin", async () => {
    for (const user of [U.engineerA, U.accountant, U.outsider]) {
      expectRejected(await as(user, "select nf_admin_set_user('newcomer@office.test','ADMIN',null)"), /ADMIN_REQUIRED/);
    }
    expectRejected(await as(null, "select nf_admin_set_user('newcomer@office.test','ADMIN',null)"), /permission denied/);
  });

  it("lets an admin add a login with a role and a person, after which it can log its own time", async () => {
    expectAccepted(await as(U.admin, "select nf_admin_set_user(' Newcomer@Office.test ','ENGINEER',$1)", [P.free]));
    const [row] = await root("select role, person_id, email from user_roles where user_id=$1", [U.newcomer]);
    expect(row).toEqual({ role: "ENGINEER", person_id: P.free, email: "newcomer@office.test" });
    expectAccepted(await insertEntry(U.newcomer, { person: P.free }));
    expectRejected(await insertEntry(U.newcomer, { person: P.a }), /TIME_ENTRY_NOT_OWN/);
  });

  it("explains what is wrong with a bad request", async () => {
    expectRejected(await as(U.admin, "select nf_admin_set_user('nobody@office.test','ENGINEER',null)"), /LOGIN_NOT_FOUND/);
    expectRejected(await as(U.admin, "select nf_admin_set_user('outsider@office.test','OWNER',null)"), /INVALID_ROLE/);
    expectRejected(await as(U.admin, "select nf_admin_set_user('outsider@office.test','ENGINEER',$1)", [P.a]), /PERSON_ALREADY_LINKED/);
    expectRejected(await as(U.admin, "select nf_admin_set_user('outsider@office.test','ENGINEER',$1)", [newUuid()]), /PERSON_NOT_FOUND/);
    expectRejected(await as(U.admin, "select nf_admin_set_user('admin@office.test','ENGINEER',null)"), /CANNOT_DEMOTE_SELF/);
    expect(await root("select 1 from user_roles where user_id=$1", [U.outsider])).toEqual([]);
  });
});

describe("the desktop path is unchanged", () => {
  it("lets an accountant write anyone's entry, at any date, keeping the device timestamp", async () => {
    const stamp = "2026-03-04T05:06:07.890Z";
    const outcome = await insertEntry(U.accountant, { person: P.b, date: day(-200), updatedAt: stamp });
    expectAccepted(outcome);
    expect(new Date(outcome.rows[0].updated_at as string).toISOString()).toBe(stamp);

    const uuid = outcome.rows[0].uuid as string;
    const later = "2026-03-05T00:00:00.000Z";
    expectAccepted(await as(U.accountant, "update time_entries set minutes=10, updated_at=$2 where uuid=$1", [uuid, later]));
    expect(new Date((await entry(uuid))!.updated_at as string).toISOString()).toBe(later);

    const removed = await as(U.accountant, "delete from time_entries where uuid=$1", [uuid]);
    expectAccepted(removed);
    expect(removed.affected).toBe(1);
  });

  it("still drops a stale accountant write (last write wins)", async () => {
    const uuid = await seedEntry(P.a, day(0), "2026-06-01T00:00:00.000Z");
    const stale = await as(U.accountant, "update time_entries set minutes=7, updated_at='2026-05-01T00:00:00Z' where uuid=$1", [uuid]);
    expectAccepted(stale);
    expect((await entry(uuid))!.minutes).toBe(60);
  });

  it("leaves writes with no login (SQL editor, service role) alone", async () => {
    const uuid = await seedEntry(P.a, day(-400), "2026-02-02T02:02:02.000Z");
    expect(new Date((await entry(uuid))!.updated_at as string).toISOString()).toBe("2026-02-02T02:02:02.000Z");
  });
});
