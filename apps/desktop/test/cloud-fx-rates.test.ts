import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { APPLY_ORDER, docs, SUPABASE_STUBS } from "./cloud-db";

/**
 * The cloud table the desktop publishes its exchange rates to, for the phone
 * to read (docs/supabase-0024-fx-rates.sql). Runs the real scripts in an
 * embedded Postgres and tries each login, as the other cloud tests do.
 */

const SCRIPT = "supabase-0024-fx-rates.sql";
const U = {
  admin: "a0000000-0000-4000-8000-000000000001",
  accountant: "a0000000-0000-4000-8000-000000000002",
  engineer: "a0000000-0000-4000-8000-000000000003",
  outsider: "a0000000-0000-4000-8000-000000000006", // a login with no role row
};

type Outcome = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };
let db: PGlite;

async function as(user: string, sql: string, params: unknown[] = []): Promise<Outcome> {
  await db.exec("begin");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    const result = await db.query<Record<string, unknown>>(sql, params);
    await db.exec("commit");
    return { ok: true, rows: result.rows };
  } catch (error) {
    await db.exec("rollback");
    return { ok: false, error: (error as Error).message };
  }
}

const root = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const rate = async (code: string) => (await root("select fx_rate_micro::int as r, updated_at from fx_rates where code=$1", [code]))[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const file of APPLY_ORDER) await db.exec(docs(file));
  await db.exec(docs(SCRIPT));
  for (const [name, id] of Object.entries(U)) {
    await root("insert into auth.users (id, email) values ($1,$2)", [id, `${name}@office.test`]);
  }
  for (const [user, role] of [[U.admin, "ADMIN"], [U.accountant, "ACCOUNTANT"], [U.engineer, "ENGINEER"]] as const) {
    await root("insert into user_roles (user_id, email, role) select id, email, $2 from auth.users where id=$1", [user, role]);
  }
  await root("insert into fx_rates (code, fx_rate_micro, updated_at) values ('SAR', 12850000, '2026-11-01T00:00:00Z')");
}, 120_000);

describe("who can read and write the published rates", () => {
  it("lets every login with a role read them, so the phone can", async () => {
    for (const user of [U.admin, U.accountant, U.engineer]) {
      const outcome = await as(user, "select code, fx_rate_micro::int as r from fx_rates");
      expect(outcome.ok && outcome.rows).toEqual([{ code: "SAR", r: 12850000 }]);
    }
  });

  it("shows nothing to a login with no role", async () => {
    const outcome = await as(U.outsider, "select code from fx_rates");
    expect(outcome.ok && outcome.rows).toEqual([]);
  });

  it("lets the finance logins publish a rate and move it forward", async () => {
    for (const user of [U.admin, U.accountant]) {
      const insert = await as(user, "insert into fx_rates (code, fx_rate_micro, updated_at) values ($1, 3750000, now())", [user === U.admin ? "AED" : "QAR"]);
      expect(insert.ok, insert.ok ? "" : insert.error).toBe(true);
    }
    const update = await as(U.accountant, "update fx_rates set fx_rate_micro=12900000, updated_at='2026-11-20T00:00:00Z' where code='SAR' returning code");
    expect(update.ok && update.rows).toHaveLength(1);
    expect((await rate("SAR"))!.r).toBe(12900000);
  });

  it("refuses an engineer login any change, which is what keeps the phone from writing it", async () => {
    const insert = await as(U.engineer, "insert into fx_rates (code, fx_rate_micro, updated_at) values ('USD', 48000000, now())");
    expect(insert.ok).toBe(false);
    expect(!insert.ok && insert.error).toMatch(/row-level security/);
    const update = await as(U.engineer, "update fx_rates set fx_rate_micro=1 where code='SAR' returning code");
    expect(update.ok && update.rows).toEqual([]);
    const remove = await as(U.engineer, "delete from fx_rates where code='SAR' returning code");
    expect(remove.ok && remove.rows).toEqual([]);
    expect((await rate("SAR"))!.r).toBe(12900000);
  });

  it("refuses a login with no role any change", async () => {
    const outcome = await as(U.outsider, "insert into fx_rates (code, fx_rate_micro, updated_at) values ('USD', 48000000, now())");
    expect(outcome.ok).toBe(false);
  });
});

describe("what a rate row may hold", () => {
  const insert = (code: string, micro: number) =>
    as(U.admin, "insert into fx_rates (code, fx_rate_micro, updated_at) values ($1,$2,now())", [code, micro]);

  it("refuses a zero or negative rate", async () => {
    expect((await insert("USD", 0)).ok).toBe(false);
    expect((await insert("USD", -5)).ok).toBe(false);
  });

  it("refuses EGP, which is always 1, and anything that is not a three-letter code", async () => {
    expect((await insert("EGP", 1_000_000)).ok).toBe(false);
    expect((await insert("usd", 48_000_000)).ok).toBe(false);
    expect((await insert("DOLLAR", 48_000_000)).ok).toBe(false);
  });

  it("keeps a newer rate when an older one arrives from another PC", async () => {
    const stale = await as(U.admin, "update fx_rates set fx_rate_micro=11000000, updated_at='2026-10-01T00:00:00Z' where code='SAR' returning code");
    expect(stale.ok && stale.rows).toEqual([]); // the last-writer-wins guard skipped it
    expect((await rate("SAR"))!.r).toBe(12900000);
    const same = await as(U.admin, "update fx_rates set fx_rate_micro=11000000, updated_at='2026-11-20T00:00:00Z' where code='SAR' returning code");
    expect(same.ok && same.rows).toEqual([]); // an equal time also loses
  });
});

describe("the script", () => {
  it("can be applied twice without losing a published rate", async () => {
    await db.exec(docs(SCRIPT));
    expect((await rate("SAR"))!.r).toBe(12900000);
    const policies = await root("select policyname from pg_policies where schemaname='public' and tablename='fx_rates' order by policyname");
    expect(policies.map((p) => p.policyname)).toEqual(["namaa_finance_write", "namaa_member_read"]);
  });

  it("refuses to run before the role helpers exist", async () => {
    const bare = new PGlite();
    await bare.exec(SUPABASE_STUBS);
    await expect(bare.exec(docs(SCRIPT))).rejects.toThrow(/PREREQUISITE_MISSING/);
    // The base schema alone has the last-writer-wins guard but not the role
    // helpers from the hardening script: still refused, with the reason.
    const unhardened = new PGlite();
    await unhardened.exec(SUPABASE_STUBS);
    await unhardened.exec(docs("supabase-schema.sql"));
    await expect(unhardened.exec(docs(SCRIPT))).rejects.toThrow(/PREREQUISITE_MISSING: role helpers/);
  });
});
