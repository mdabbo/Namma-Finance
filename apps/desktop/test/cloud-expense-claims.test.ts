import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { APPLY_ORDER, docs, SUPABASE_STUBS } from "./cloud-db";

/**
 * Cloud rules for expense claims (docs/supabase-0025-expense-claims.sql, plan
 * step F6). Runs the REAL scripts, unmodified and in apply order, in an
 * embedded Postgres, then signs in as each login and tries the writes. The
 * phone talks to Supabase directly, so what a login may do to a claim is
 * decided here and nowhere else.
 */

const CLAIMS = "supabase-0025-expense-claims.sql";
const TIME_CAPTURE = "supabase-0021-time-entry-capture.sql";

const U = {
  admin: "a0000000-0000-4000-8000-000000000001",
  accountant: "a0000000-0000-4000-8000-000000000002",
  engineerA: "a0000000-0000-4000-8000-000000000003",
  engineerB: "a0000000-0000-4000-8000-000000000004",
  unlinked: "a0000000-0000-4000-8000-000000000005", // ENGINEER role, no person
  outsider: "a0000000-0000-4000-8000-000000000006", // a login with no role row
};
const P = { a: "b0000000-0000-4000-8000-000000000001", b: "b0000000-0000-4000-8000-000000000002" };
const CLIENT = "c0000000-0000-4000-8000-000000000001";
const PROJECT = "d0000000-0000-4000-8000-000000000001";
const PROJECT_DELETED = "d0000000-0000-4000-8000-000000000003";
const CATEGORY = "f0000000-0000-4000-8000-000000000001";
const CATEGORY_DELETED = "f0000000-0000-4000-8000-000000000002";
const SHA = "a".repeat(64);

let seq = 0;
const newUuid = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

type Outcome = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };
let db: PGlite;

async function as(user: string | null, sql: string, params: unknown[] = []): Promise<Outcome> {
  await db.exec("begin");
  try {
    if (user === null) {
      await db.exec("set local role anon");
    } else {
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    }
    const result = await db.query<Record<string, unknown>>(sql, params);
    await db.exec("commit");
    return { ok: true, rows: result.rows };
  } catch (error) {
    await db.exec("rollback");
    return { ok: false, error: (error as Error).message };
  }
}

const root = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;

function expectRejected(outcome: Outcome, reason: RegExp): void {
  expect(outcome.ok, outcome.ok ? "the write was accepted" : outcome.error).toBe(false);
  if (!outcome.ok) expect(outcome.error).toMatch(reason);
}
function expectAccepted(outcome: Outcome): asserts outcome is Extract<Outcome, { ok: true }> {
  expect(outcome.ok, outcome.ok ? "" : outcome.error).toBe(true);
}
// A BEFORE trigger runs ahead of row-level security and of CHECK constraints, so a
// write the guard names is refused with the guard's reason, and one it does not
// reach is refused by the policy or the constraint.
const RLS = /row-level security/;
const NOT_OWN = /CLAIM_NOT_OWN|row-level security/;

interface ClaimInput {
  uuid?: string;
  person?: string;
  project?: string | null;
  category?: string | null;
  date?: string;
  amount?: number;
  currency?: string;
  description?: string;
  receiptFolder?: string | null; // user id whose folder holds the photo
  receiptKey?: string | null;
  sha?: string | null;
  decision?: string | null;
  decidedAt?: string | null;
  updatedAt?: string;
}

function insertClaim(user: string | null, c: ClaimInput = {}): Promise<Outcome> {
  const uuid = c.uuid ?? newUuid();
  const key = c.receiptKey !== undefined ? c.receiptKey : c.receiptFolder ? `${c.receiptFolder}/claims/${uuid}.jpg` : null;
  return as(
    user,
    `insert into expense_claims (uuid, person_id, project_id, category_id, date, amount_minor, currency, description,
        receipt_storage_key, receipt_sha256, submitted_at, decision, decided_at, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,'2026-01-01 08:00:00',$13) returning uuid, updated_at`,
    [
      uuid, c.person ?? P.a, c.project === undefined ? PROJECT : c.project, c.category ?? null, c.date ?? day(0),
      c.amount ?? 15_000, c.currency ?? "EGP", c.description ?? "Printing the drawings",
      key, c.sha !== undefined ? c.sha : key ? SHA : null, c.decision ?? null, c.decidedAt ?? null,
      c.updatedAt ?? new Date().toISOString(),
    ],
  );
}

/** A claim seeded with no login, as the SQL editor would. */
async function seedClaim(overrides: { person?: string; decision?: "ACCEPTED" | "REJECTED" } = {}): Promise<string> {
  const uuid = newUuid();
  await root(
    `insert into expense_claims (uuid, person_id, project_id, date, amount_minor, currency, description, submitted_at,
        decision, decided_at, decision_reason, created_at, updated_at)
     values ($1,$2,$3,$4,15000,'EGP','Printing',now(),$5,$6,$7,'2026-01-01 08:00:00','2026-01-01T00:00:00Z')`,
    [
      uuid, overrides.person ?? P.a, PROJECT, day(-2), overrides.decision ?? null,
      overrides.decision ? new Date().toISOString() : null,
      overrides.decision === "REJECTED" ? "Not a project cost" : null,
    ],
  );
  return uuid;
}

const claim = async (uuid: string) => (await root("select * from expense_claims where uuid=$1", [uuid]))[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const file of APPLY_ORDER) await db.exec(docs(file));
  await db.exec(docs(TIME_CAPTURE));
  await db.exec(docs(CLAIMS));

  for (const [name, id] of Object.entries(U)) await root("insert into auth.users (id, email) values ($1,$2)", [id, `${name}@office.test`]);
  for (const [name, id] of Object.entries(P)) {
    await root("insert into people (uuid, name, hourly_rate_minor, updated_at) values ($1,$2,5000,now())", [id, `Person ${name}`]);
  }
  const roles: [string, string, string | null][] = [
    [U.admin, "ADMIN", null], [U.accountant, "ACCOUNTANT", null],
    [U.engineerA, "ENGINEER", P.a], [U.engineerB, "ENGINEER", P.b], [U.unlinked, "ENGINEER", null],
  ];
  for (const [user, role, person] of roles) {
    await root("insert into user_roles (user_id, email, role, person_id) select id, email, $2, $3 from auth.users where id=$1", [user, role, person]);
  }
  await root("insert into clients (uuid, name, updated_at) values ($1,'Client',now())", [CLIENT]);
  await root("insert into expense_categories (uuid, name_en, name_ar, updated_at) values ($1,'Site','موقع',now())", [CATEGORY]);
  await root("insert into expense_categories (uuid, name_en, name_ar, updated_at, deleted_at) values ($1,'Old','قديم',now(),now())", [CATEGORY_DELETED]);
  for (const [uuid, code, deleted] of [[PROJECT, "P-1", null], [PROJECT_DELETED, "P-3", "2026-01-01T00:00:00Z"]] as const) {
    await root("insert into projects (uuid, code, name, client_id, updated_at, deleted_at) values ($1,$2,$2,$3,now(),$4)", [uuid, code, CLIENT, deleted]);
  }
}, 120_000);

describe("who can read claims", () => {
  it("lets every login with a role read them", async () => {
    const uuid = await seedClaim();
    for (const user of [U.admin, U.accountant, U.engineerA, U.engineerB]) {
      const outcome = await as(user, "select uuid from expense_claims where uuid=$1", [uuid]);
      expectAccepted(outcome);
      expect(outcome.rows).toHaveLength(1);
    }
  });

  it("shows nothing to a login with no role, or no login", async () => {
    const uuid = await seedClaim();
    for (const user of [U.outsider, null]) {
      const outcome = await as(user, "select uuid from expense_claims where uuid=$1", [uuid]);
      expect(outcome.ok && outcome.rows).toEqual([]);
    }
  });
});

describe("an engineer filing a claim", () => {
  it("can file a claim for their own person", async () => {
    expectAccepted(await insertClaim(U.engineerA));
  });

  it("is stamped with the server's time, whatever the phone's clock says", async () => {
    const outcome = await insertClaim(U.engineerA, { updatedAt: "2020-01-01T00:00:00.000Z" });
    expectAccepted(outcome);
    expect(Date.now() - Date.parse(String(outcome.rows[0]!.updated_at))).toBeLessThan(60_000);
  });

  it("cannot file for someone else, or without a linked person", async () => {
    expectRejected(await insertClaim(U.engineerA, { person: P.b }), NOT_OWN);
    expectRejected(await insertClaim(U.unlinked), NOT_OWN);
    expectRejected(await insertClaim(U.outsider), NOT_OWN);
    expectRejected(await insertClaim(null), /permission denied|row-level security/);
  });

  it("cannot file an already decided claim", async () => {
    expectRejected(await insertClaim(U.engineerA, { decision: "ACCEPTED", decidedAt: new Date().toISOString() }), /CLAIM_DECISION_FORBIDDEN/);
  });

  it("must give a real date that is not in the future, but may claim an old receipt", async () => {
    expectRejected(await insertClaim(U.engineerA, { date: "2026-02-30" }), /CLAIM_INVALID_DATE/);
    expectRejected(await insertClaim(U.engineerA, { date: "11/02/2026" }), /CLAIM_INVALID_DATE/);
    expectRejected(await insertClaim(U.engineerA, { date: day(5) }), /CLAIM_INVALID_DATE/);
    expectAccepted(await insertClaim(U.engineerA, { date: day(1) }));
    expectAccepted(await insertClaim(U.engineerA, { date: day(-200) }));
  });

  it("must claim a positive amount, a real currency and a description", async () => {
    expectRejected(await insertClaim(U.engineerA, { amount: 0 }), /check constraint/);
    expectRejected(await insertClaim(U.engineerA, { amount: -5 }), /check constraint/);
    expectRejected(await insertClaim(U.engineerA, { currency: "egp" }), /check constraint/);
    expectRejected(await insertClaim(U.engineerA, { currency: "EGPX" }), /check constraint/);
    expectRejected(await insertClaim(U.engineerA, { description: "   " }), /check constraint/);
  });

  it("can name a live project and category, but not a removed one", async () => {
    expectAccepted(await insertClaim(U.engineerA, { project: PROJECT, category: CATEGORY }));
    expectAccepted(await insertClaim(U.engineerA, { project: null }));
    expectRejected(await insertClaim(U.engineerA, { project: PROJECT_DELETED }), /CLAIM_PROJECT_UNAVAILABLE/);
    expectRejected(await insertClaim(U.engineerA, { category: CATEGORY_DELETED }), /CLAIM_CATEGORY_UNAVAILABLE/);
    expectRejected(await insertClaim(U.engineerA, { project: newUuid() }), /CLAIM_PROJECT_UNAVAILABLE|foreign key/);
  });
});

describe("the receipt photo", () => {
  it("is a file and its fingerprint together, and the fingerprint is a sha-256", async () => {
    const uuid = newUuid();
    expectAccepted(await insertClaim(U.engineerA, { uuid, receiptFolder: U.engineerA }));
    const own = newUuid();
    expectRejected(await insertClaim(U.engineerA, { uuid: own, receiptKey: `${U.engineerA}/claims/${own}.jpg`, sha: null }), /expense_claims_receipt_pair/);
    expectRejected(await insertClaim(U.engineerA, { receiptFolder: U.engineerA, sha: "xyz" }), /expense_claims_receipt_sha/);
    expectRejected(await insertClaim(U.engineerA, { receiptFolder: U.engineerA, sha: "A".repeat(64) }), /expense_claims_receipt_sha/);
    expectRejected(await insertClaim(U.engineerA, { receiptKey: null, sha: SHA }), /expense_claims_receipt_pair/);
  });

  it("must be named for this claim, so a claim cannot point at another file", async () => {
    expectRejected(await insertClaim(U.engineerA, { receiptKey: `${U.engineerA}/claims/${newUuid()}.jpg` }), /CLAIM_INVALID_RECEIPT/);
    expectRejected(await insertClaim(U.engineerA, { receiptKey: `${U.engineerA}/other/x.jpg` }), /CLAIM_INVALID_RECEIPT/);
    const uuid = newUuid();
    expectRejected(await insertClaim(U.engineerA, { uuid, receiptKey: `${U.engineerA}/claims/${uuid}.png` }), /CLAIM_INVALID_RECEIPT/);
    expectRejected(await insertClaim(U.engineerA, { uuid: newUuid(), receiptKey: "claims/x.jpg" }), /CLAIM_INVALID_RECEIPT/);
  });

  it("must sit in the engineer's own folder, the only one they can write", async () => {
    expectRejected(await insertClaim(U.engineerA, { receiptFolder: U.engineerB }), /CLAIM_INVALID_RECEIPT/);
    expectAccepted(await insertClaim(U.admin, { receiptFolder: U.admin })); // a finance login: its own folder
    expectAccepted(await insertClaim(U.accountant, { receiptFolder: U.engineerA })); // the office may file one an engineer sent
  });
});

describe("an engineer changing their own claim", () => {
  it("can change a pending claim, and the server moves updated_at forward", async () => {
    const uuid = await seedClaim();
    const before = String((await claim(uuid))!.updated_at);
    const outcome = await as(U.engineerA, "update expense_claims set amount_minor=20000, description='Plotting' where uuid=$1 returning amount_minor, updated_at", [uuid]);
    expectAccepted(outcome);
    expect(outcome.rows).toHaveLength(1);
    expect(Number(outcome.rows[0]!.amount_minor)).toBe(20000);
    expect(Date.parse(String(outcome.rows[0]!.updated_at))).toBeGreaterThan(Date.parse(before));
  });

  it("cannot change whose claim it is, or its identity and dates", async () => {
    const uuid = await seedClaim();
    expectRejected(await as(U.engineerA, "update expense_claims set person_id=$2 where uuid=$1", [uuid, P.b]), /CLAIM_NOT_OWN|row-level security/);
    expectRejected(await as(U.engineerA, "update expense_claims set created_at='2000-01-01' where uuid=$1", [uuid]), /CLAIM_IMMUTABLE_FIELD/);
    expectRejected(await as(U.engineerA, "update expense_claims set submitted_at=now() - interval '5 days' where uuid=$1", [uuid]), /CLAIM_IMMUTABLE_FIELD/);
  });

  it("cannot decide a claim, even their own", async () => {
    const uuid = await seedClaim();
    expectRejected(await as(U.engineerA, "update expense_claims set decision='ACCEPTED', decided_at=now() where uuid=$1", [uuid]), /CLAIM_DECISION_FORBIDDEN/);
    expect((await claim(uuid))!.decision).toBeNull();
    // Each decision field on its own is the office's too.
    for (const sql of ["decision='ACCEPTED'", "decided_at=now()", "decided_by='Me'", "decision_reason='Because'"]) {
      expectRejected(await as(U.engineerA, `update expense_claims set ${sql} where uuid=$1`, [uuid]), /CLAIM_DECISION_FORBIDDEN/);
    }
  });

  it("cannot touch another engineer's claim", async () => {
    const uuid = await seedClaim({ person: P.b });
    const outcome = await as(U.engineerA, "update expense_claims set amount_minor=1 where uuid=$1 returning uuid", [uuid]);
    expect(outcome.ok && outcome.rows).toEqual([]);
    expect(Number((await claim(uuid))!.amount_minor)).toBe(15000);
  });

  it("can withdraw a pending claim, which the desktops can pull, but never delete it", async () => {
    const uuid = await seedClaim();
    const withdraw = await as(U.engineerA, "update expense_claims set deleted_at=now() where uuid=$1 returning uuid", [uuid]);
    expect(withdraw.ok && withdraw.rows).toHaveLength(1);
    const remove = await as(U.engineerA, "delete from expense_claims where uuid=$1 returning uuid", [uuid]);
    expect(remove.ok && remove.rows).toEqual([]);
    expect(await claim(uuid)).toBeDefined();
  });
});

describe("the office deciding a claim", () => {
  const decide = (user: string, uuid: string, sql: string) => as(user, `update expense_claims set ${sql} where uuid=$1 returning decision`, [uuid]);

  it("lets finance logins accept a claim", async () => {
    for (const user of [U.admin, U.accountant]) {
      const uuid = await seedClaim();
      const outcome = await decide(user, uuid, `decision='ACCEPTED', decided_at=now(), decided_by='${user === U.admin ? "Admin" : "Accountant"}', updated_at=now() + interval '1 second'`);
      expectAccepted(outcome);
      expect(outcome.rows).toEqual([{ decision: "ACCEPTED" }]);
    }
  });

  it("needs a reason to reject", async () => {
    const uuid = await seedClaim();
    expectRejected(await decide(U.accountant, uuid, "decision='REJECTED', decided_at=now(), updated_at=now() + interval '1 second'"), /expense_claims_rejection_reason/);
    expectRejected(await decide(U.accountant, uuid, "decision='REJECTED', decided_at=now(), decision_reason='  ', updated_at=now() + interval '1 second'"), /expense_claims_rejection_reason/);
    expectAccepted(await decide(U.accountant, uuid, "decision='REJECTED', decided_at=now(), decision_reason='Not a project cost', updated_at=now() + interval '1 second'"));
  });

  it("keeps a decision whole: all its fields together, or none", async () => {
    const uuid = await seedClaim();
    expectRejected(await decide(U.accountant, uuid, "decision='ACCEPTED', updated_at=now() + interval '1 second'"), /expense_claims_decision_shape/);
    expectRejected(await decide(U.accountant, uuid, "decided_at=now(), updated_at=now() + interval '1 second'"), /expense_claims_decision_shape/);
    expectRejected(await decide(U.accountant, uuid, "decision='MAYBE', decided_at=now(), updated_at=now() + interval '1 second'"), /check constraint/);
  });

  it("lets the office set the category on a pending claim", async () => {
    const uuid = await seedClaim();
    expectAccepted(await decide(U.accountant, uuid, `category_id='${CATEGORY}', updated_at=now() + interval '1 second'`));
    expect((await claim(uuid))!.category_id).toBe(CATEGORY);
  });
});

describe("a decided claim is evidence", () => {
  const edit = (user: string | null, uuid: string, sql: string) => as(user, `update expense_claims set ${sql}, updated_at=now() + interval '1 hour' where uuid=$1 returning uuid`, [uuid]);

  it("cannot be changed by an engineer, whose own policy would otherwise allow it", async () => {
    for (const decision of ["ACCEPTED", "REJECTED"] as const) {
      const uuid = await seedClaim({ decision });
      expectRejected(await edit(U.engineerA, uuid, "amount_minor=99999"), /CLAIM_DECIDED_IMMUTABLE/);
      expectRejected(await edit(U.engineerA, uuid, "deleted_at=now()"), /CLAIM_DECIDED_IMMUTABLE/);
      expect(Number((await claim(uuid))!.amount_minor)).toBe(15000);
    }
  });

  it("cannot be changed by a finance login either, so a stale phone edit cannot disagree with the expense", async () => {
    const uuid = await seedClaim({ decision: "ACCEPTED" });
    for (const sql of [
      "amount_minor=99999", "description='Changed'", "currency='USD'", "date='2020-01-01'", "project_id=null",
      `category_id='${CATEGORY}'`, "supplier='Someone'", "decision='REJECTED', decision_reason='x'", "decided_at=now() - interval '3 days'",
      "decided_by='Someone else'", "person_id='" + P.b + "'",
    ]) {
      expectRejected(await edit(U.admin, uuid, sql), /CLAIM_DECIDED_IMMUTABLE/);
      expectRejected(await edit(U.accountant, uuid, sql), /CLAIM_DECIDED_IMMUTABLE/);
    }
    expect(Number((await claim(uuid))!.amount_minor)).toBe(15000);
  });

  it("cannot have its decision turned round, even with the reason left as it was", async () => {
    const uuid = await seedClaim({ decision: "REJECTED" });
    expectRejected(await edit(U.admin, uuid, "decision='ACCEPTED'"), /CLAIM_DECIDED_IMMUTABLE/);
    expect((await claim(uuid))!.decision).toBe("REJECTED");
  });

  it("keeps its claimant: a person with claims cannot be removed", async () => {
    const person = "b0000000-0000-4000-8000-000000000099";
    await root("insert into people (uuid, name, hourly_rate_minor, updated_at) values ($1,'Leaver',0,now())", [person]);
    await seedClaim({ person });
    await expect(root("delete from people where uuid=$1", [person])).rejects.toThrow(/foreign key/);
  });

  it("still lets the desktop re-send it unchanged and finance withdraw it", async () => {
    const uuid = await seedClaim({ decision: "ACCEPTED" });
    expectAccepted(await edit(U.admin, uuid, "amount_minor=amount_minor"));
    expectAccepted(await edit(U.accountant, uuid, "deleted_at=now()"));
  });

  it("can still be corrected from the SQL editor, which is not a login", async () => {
    const uuid = await seedClaim({ decision: "ACCEPTED" });
    // updated_at moves too: the last-writer-wins guard skips any update that does not.
    await root("update expense_claims set description='Fixed by hand', updated_at=now() + interval '1 hour' where uuid=$1", [uuid]);
    expect((await claim(uuid))!.description).toBe("Fixed by hand");
  });

  it("does not let an older write replace a newer one", async () => {
    const uuid = await seedClaim();
    const stale = await as(U.admin, "update expense_claims set description='Stale', updated_at='2020-01-01T00:00:00Z' where uuid=$1 returning uuid", [uuid]);
    expect(stale.ok && stale.rows).toEqual([]);
    expect((await claim(uuid))!.description).toBe("Printing");
  });
});

describe("receipt files in storage", () => {
  const put = (folder: string, file: string) =>
    root("insert into storage.objects (bucket_id, name, owner) values ('namaa-documents', $1, $2)", [`${folder}/claims/${file}`, folder]);
  const list = (user: string) => as(user, "select name from storage.objects where bucket_id='namaa-documents' order by name");

  beforeAll(async () => {
    // Supabase grants these on storage.objects; the stub schema does not.
    await root("grant select, insert, update, delete on storage.objects to authenticated");
    await put(U.engineerA, "a.jpg");
    await put(U.engineerB, "b.jpg");
    // A file in some other bucket: the new rule must not open it.
    await root("insert into storage.objects (bucket_id, name, owner) values ('other-bucket', $1, $2)", [`${U.engineerA}/private.jpg`, U.engineerA]);
  });

  it("opens the receipt bucket only, not every bucket", async () => {
    const outcome = await as(U.accountant, "select name from storage.objects where bucket_id <> 'namaa-documents'");
    expect(outcome.ok && outcome.rows).toEqual([]);
  });

  it("can be read by finance logins in any folder", async () => {
    for (const user of [U.admin, U.accountant]) {
      const outcome = await list(user);
      expectAccepted(outcome);
      expect(outcome.rows.map((r) => String(r.name).split("/")[0]).sort()).toEqual([U.engineerA, U.engineerB].sort());
    }
  });

  it("can be read by an engineer only in their own folder", async () => {
    const outcome = await list(U.engineerA);
    expectAccepted(outcome);
    expect(outcome.rows.map((r) => String(r.name).split("/")[0])).toEqual([U.engineerA]);
  });

  it("cannot be read by a login with no role", async () => {
    const outcome = await list(U.outsider);
    expect(outcome.ok && outcome.rows).toEqual([]);
  });

  it("gives finance read access only: it cannot write into another folder", async () => {
    const insert = await as(U.accountant, "insert into storage.objects (bucket_id, name, owner) values ('namaa-documents', $1, $2)", [`${U.engineerA}/claims/x.jpg`, U.accountant]);
    expectRejected(insert, RLS);
  });
});

describe("the script", () => {
  it("leaves the table with the finance, member and two own-claim policies", async () => {
    const rows = await root("select policyname, cmd from pg_policies where schemaname='public' and tablename='expense_claims' order by policyname");
    expect(rows).toEqual([
      { policyname: "namaa_finance_write", cmd: "ALL" },
      { policyname: "namaa_member_read", cmd: "SELECT" },
      { policyname: "namaa_self_claim_insert", cmd: "INSERT" },
      { policyname: "namaa_self_claim_update", cmd: "UPDATE" },
    ]);
  });

  it("can be applied twice without losing a claim", async () => {
    const uuid = await seedClaim();
    await db.exec(docs(CLAIMS));
    expect(await claim(uuid)).toBeDefined();
    const [{ n }] = await root("select count(*)::int as n from pg_policies where schemaname='public' and tablename='expense_claims'") as { n: number }[];
    expect(n).toBe(4);
  });

  it("refuses to run before its prerequisites exist", async () => {
    const bare = new PGlite();
    await bare.exec(SUPABASE_STUBS);
    await expect(bare.exec(docs(CLAIMS))).rejects.toThrow(/PREREQUISITE_MISSING/);
    const noCapture = new PGlite();
    await noCapture.exec(SUPABASE_STUBS);
    for (const file of APPLY_ORDER) await noCapture.exec(docs(file));
    await expect(noCapture.exec(docs(CLAIMS))).rejects.toThrow(/PREREQUISITE_MISSING: nf_is_own_person/);
  }, 60_000);
});
