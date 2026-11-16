# F0.2 — cloud policies for phone capture (design)

Written 2026-11-16. Status on 2026-11-17: **delta A is written and tested but
NOT applied to the live project** — `docs/supabase-0021-time-entry-capture.sql`,
its read-only `docs/supabase-0021-preflight.sql`, and
`apps/desktop/test/cloud-policies.test.ts`, which runs the real scripts in an
embedded Postgres (PGlite; they run unmodified). Delta C (claims) is still
design only. The sketch in section 9 is superseded by the real script.

Two things changed from this design while building delta A: the date check
uses `nf_capture_parse_date()` (Postgres rejects `2026-02-30` with its own
error before a named one could be raised), and the guard also refuses a
change of `uuid` (`TIME_ENTRY_IMMUTABLE_FIELD`) and an invalid `billable`
(`TIME_ENTRY_INVALID_BILLABLE`).

Read `docs/DEVELOPMENT-PLAN.md` sections 2, 5.1 and 11 first.

---

## 1. What is live today (verified 2026-11-16)

From `docs/supabase-policy-preflight.sql`, run by the owner on the office
project:

- RLS is on for every table. No `office_all` policy remains.
- **Read**: any login with a `user_roles` row reads every table
  (`namaa_member_read`).
- **Write**: ADMIN and ACCOUNTANT on every table (`namaa_finance_write`);
  ENGINEER additionally on `project_stages`, `documents`, `stage_progress_log`
  (`namaa_member_write`).
- `user_roles` holds one login, an ADMIN.
- Storage (`namaa-documents`): read, insert, update and delete are all limited
  to the uploader's own top-level folder (`auth.uid()`).

From the code:

- `people` has no column linking it to a login.
- **A second login cannot get a role through the app.** `refreshRole()` in
  `apps/desktop/src/lib/roles.ts` tries to insert an ADMIN row, which the
  `bootstrap_first_admin` policy rejects once the table is not empty; the UI
  then treats the login as ENGINEER but **no row is written**. Without a row
  `nf_is_member()` is false, so that login can read nothing. The Users panel
  (`SettingsPage.tsx`) only edits existing rows.
- The desktop pulls by `updated_at > cursor` (`sync/engine.ts:353`), and
  `updated_at` is supplied by the writing device. A phone whose clock is behind
  would insert a row the desktops have already moved past and **never pull**.
- Time entries feed the labour **costing** view only
  (`packages/core/src/calc/labor.ts`): minutes × hourly rate. They do not
  touch cash net profit, certificates, payments or anything invoiced.
- Cloud deletes are soft (`deleted_at`); the desktop turns a pulled soft delete
  into a local delete.

---

## 2. Decisions this design makes

| # | Decision | Reason |
|---|---|---|
| 1 | The login-to-person link is `user_roles.person_id`, **cloud only**. | `user_roles` is already admin-managed and not synced. A column on `people` would need desktop migration `0009`, a registry change, and every desktop upgraded before the next sync — and would copy auth identifiers into every local database. This replaces the plan's "schema change on both sides". |
| 2 | Ownership is enforced by **policies**; field rules by a **trigger**. | A policy failure returns a generic RLS error. The phone's queue must show *why* a record was rejected, so domain checks raise named errors from a trigger. The policy stays the security boundary. |
| 3 | The server stamps `updated_at` on every non-finance write. | Removes phone clock skew from the desktop's pull cursor (section 1). Desktop writes are left exactly as they are. |
| 4 | Engineers get INSERT and UPDATE on their own rows, **never DELETE**. | A delete is a soft delete, which is an UPDATE. A hard delete would vanish without the desktops ever hearing of it. |
| 5 | Expense capture is a **claim**, a separate table. The desktop turns an accepted claim into an expense. | An expense affects profit; a claim does not. Keeps the ledger desktop-owned (plan 11.3 F0.3). |
| 6 | Ship in two deltas, in this order: **A** link + time entries, **C** claims. Delta B (engineer read scope) is **not being built** — owner decision, section 4. | A unblocks F5 with no desktop change. C needs a desktop migration and is only needed for F6. |

---

## 3. Delta A — link and own time entries (unblocks F5; no desktop change)

### 3.1 The link

- `user_roles.person_id uuid null references people(uuid) on delete set null`
- Partial unique index: one login per person.
- `nf_my_person_id()` — `security definer`, returns the caller's `person_id`.
- `nf_is_own_person(uuid)` — true when the argument is the caller's person.

Engineers cannot change their own link: `user_roles` writes are admin-only
(`admin_manage`), and `read_own_role` already lets a login read its own row,
which is how the phone learns who it is.

### 3.2 Giving a login a role

`nf_admin_set_user(email, role, person_uuid)` — `security definer`, refuses
unless `nf_is_admin()`, looks the login up in `auth.users` by email, and
upserts its `user_roles` row. This closes the gap in section 1: today there is
no way to give a second login a role without hand-written SQL.

The login itself is still created in the Supabase dashboard (Authentication →
Users); sign-up stays disabled. A desktop "Add login" control with a person
picker in Settings → Users is a small follow-up UI step (Sonnet), not part of
this delta. Until it exists, the delta's header carries a copy-paste INSERT.

### 3.3 Policies on `time_entries`

Added beside the two existing policies (permissive policies combine with OR,
so finance roles are unaffected):

| Policy | Command | Rule |
|---|---|---|
| `namaa_self_time_insert` | INSERT | `with check (nf_is_own_person(person_id))` |
| `namaa_self_time_update` | UPDATE | `using` and `with check`: `nf_is_own_person(person_id)` |

No DELETE policy for engineers.

### 3.4 Guard trigger on `time_entries`

`trg_time_entries_capture_guard`, BEFORE INSERT OR UPDATE. BEFORE triggers
fire in name order, so it runs before `trg_time_entries_lww` ("capture" sorts
before "lww") — the same technique `supabase-0020` uses.

It returns immediately for finance roles and for a null `auth.uid()` (SQL
editor, service role), so the desktop path is byte-for-byte unchanged. For
everyone else it:

- rejects a change of `person_id` or `created_at` on update;
- requires `minutes` between 1 and 60,000 and `billable` in (0, 1) — the same
  bounds as `timeEntrySchema` in the core;
- requires `date` to be a real `YYYY-MM-DD` date inside the edit window
  (section 8, decision A), checking the stored row's date as well on update so
  a locked entry cannot be moved into the window;
- requires the project to exist and not be soft-deleted, and the stage, if
  given, to belong to that project;
- sets `updated_at` to `greatest(now(), old.updated_at + 1 ms)`.

Named errors: `TIME_ENTRY_NOT_OWN`, `TIME_ENTRY_LOCKED`,
`TIME_ENTRY_INVALID_DATE`, `TIME_ENTRY_INVALID_MINUTES`,
`TIME_ENTRY_PROJECT_UNAVAILABLE`, `TIME_ENTRY_STAGE_MISMATCH`.

### 3.5 What an engineer's time entry can and cannot change

It changes the labour costing view and utilisation. It cannot change a
certified, invoiced, collected or paid figure, which is the plan's condition
in 11.4. The hourly rate lives on `people`, which engineers cannot write.

---

## 4. Delta B — what an engineer login may read

> **Owner decision, 2026-11-16: engineers may read money data. Delta B is not
> being built.** `namaa_member_read` stays as it is. The rest of this section
> is kept as the record of what that means and what the alternative was.
> Accepted consequence: any engineer login can read contract values,
> payments, and every person's rates and `bank_account` through the API,
> whatever the app's screens show. `docs/KNOWN-LIMITATIONS.md` should say so
> when the first engineer login is created.

**This is a finding, not something the plan asked for.** Today an ENGINEER
login reads every table through the API: contract values, payments, every
person's `bank_account` and rates, everyone's hours. The desktop hides the
money screens, but that is the UI; a phone talks to the API directly.

Recommended, before the first engineer login is created: replace
`namaa_member_read` with a finance-only read on the financial tables, and give
engineers:

| Table | Engineer read |
|---|---|
| `projects`, `project_stages`, `stage_progress_log`, `documents`, `expense_categories` | all rows |
| `people` | own row only |
| `time_entries`, `expense_claims` | own rows only |
| everything else | none |

`projects` carries no money except `fx_rate_micro` and `currency`; that is
acceptable. If the owner wants engineers to see nothing but names, a view can
narrow it later.

Consequences to check when this is built:

- The mobile Home screen computes finance KPIs from all tables. For an
  engineer login it must show a capture-only home instead of a dashboard of
  zeros. That is an F1/F5 screen change.
- A desktop signed in as ENGINEER would pull fewer rows. No engineer uses the
  desktop today (one login exists), but the sync engine's behaviour with
  missing parents must be tested before one does.

---

## 5. Delta C — expense claims (unblocks F6; needs desktop migration `0009`)

### 5.1 Cloud table `expense_claims`

`uuid` (pk), `person_id` (claimant), `project_id` (nullable), `category_id`
(nullable — the accountant may set it), `date`, `amount_minor bigint > 0`,
`currency`, `description`, `supplier`, `receipt_storage_key`,
`receipt_sha256`, `submitted_at`, `decision` (`ACCEPTED` / `REJECTED`, null
while pending), `decided_at`, `decided_by`, `decision_reason`, `created_at`,
`updated_at`, `deleted_at`.

No `status` column. Status is derived: no decision → pending (rule 6). No FX
rate on the claim: the rate is a finance judgment, chosen at acceptance.

### 5.2 Rules

- Engineer: INSERT own claim with all decision fields null; UPDATE own claim
  only while `decision` is null, and never the decision fields; withdraw is a
  soft delete while pending.
- Finance roles: everything.
- A guard trigger in the style of 3.4, with named errors and a server
  `updated_at`.
- Once decided, a claim is evidence: immutable except by finance roles, and
  classified `ImmutableOrEventEvidence` in `SYNC_TABLE_POLICIES`.

### 5.3 Desktop side (outline — design in detail when F6 is scheduled)

- Migration `0009`: a local `expense_claims` table; schema 31 (three places).
- Sync registry entry; `CONFLICT_PROTECTED_TABLES`; TypeScript double.
- One Rust command, `accept_expense_claim_atomic`: inserts the numbered
  expense and records the decision in the same transaction.
  `reject_expense_claim_atomic` records a decision and a reason.
- **The posted expense takes the claim's uuid as its `sync_uuid`.** Two
  desktops accepting the same claim then produce the same expense record, which
  the existing conflict handling sees as one row, rather than two expenses.
  Confirm that `trg_expenses_sync_init` leaves a supplied `sync_uuid` alone
  before relying on this.

### 5.4 Receipts

- The phone uploads to `{auth.uid()}/claims/{claim_uuid}.jpg`. The existing
  insert policy already allows this.
- Add `namaa_documents_finance_read`: finance roles may read any object in the
  bucket. Without it the accountant cannot open the photo (section 1).
- The uploader can still delete their own file. `receipt_sha256` on the claim
  makes tampering detectable; on acceptance the desktop should copy the file
  into its managed documents so the evidence no longer depends on the
  engineer's folder.

---

## 6. Proving it (plan 11.4: "a test against the policies")

Two layers:

1. **In CI** — run the schema, roles, hardening and the new deltas in an
   embedded Postgres inside vitest, with stub `auth.uid()` and `storage`
   objects, and assert as each role: an engineer can insert only their own
   time entry; cannot write any table in the plan's "desktop only" column;
   cannot change `person_id`; cannot edit a locked entry; cannot set a claim's
   decision. `@electric-sql/pglite` is the candidate; **whether it runs these
   scripts unmodified is unverified** — try it first, as its own small step.
2. **On the live project** — a script for the SQL editor that impersonates
   each role inside a transaction (`set local role authenticated` plus
   `request.jwt.claims`) and **rolls back**. It leaves nothing behind. Run it
   after each delta is applied.

Each rule gets a negative check: remove the policy line, watch the test go
red, restore (rule 8).

---

## 7. Risks left open

- **Commit-order race on the pull cursor.** `now()` is the transaction's start
  time. A phone write that starts before, and commits after, a desktop's pull
  can still land behind that desktop's cursor. The window is milliseconds and
  the same race already exists between two desktops. Not fixed here; note it in
  F9 acceptance.
- **Phone retries.** A retried insert with the same uuid hits the primary key.
  The phone must upsert with "ignore duplicates"; that is F4's job, but the
  policies above are written to allow it.
- **The owner's own phone** signs in as ADMIN and therefore has full write
  access at the API. The app staying read-only for finance is a UI promise. A
  separate lower-privilege login for the phone would remove that.
- **Existing desktop documents** are readable only by the login that uploaded
  them. With one login this has never shown. Delta C's finance read policy
  fixes it for finance roles.

---

## 8. Decisions needed from the owner

| | Question | Recommendation |
|---|---|---|
| A | How long may an engineer add or change their own time entry? | **ANSWERED 2026-11-16: the last 14 days.** An entry's `date` must be from 14 days before today (server date, UTC) up to one day after today; the extra day absorbs the office being ahead of UTC. Outside that range the write fails with `TIME_ENTRY_LOCKED`. No schema change. Finance roles are not limited. |
| B | May an engineer login read money data (contracts, payments, rates, bank accounts)? | **ANSWERED 2026-11-16: yes, allow it.** (The recommendation was no.) Delta B dropped. |
| C | Confirm the claim flow: the phone submits, the accountant accepts or rejects on the desktop, and only acceptance creates an expense. | Yes. |
| D | Which engineers get a login first? Each needs a `people` row and an email. | Start with one, for F9 acceptance. |

---

## 9. Sketch of delta A (NOT APPLIED, NEVER RUN — for review only)

```sql
alter table public.user_roles
  add column if not exists person_id uuid references public.people(uuid) on delete set null;
create unique index if not exists uq_user_roles_person
  on public.user_roles(person_id) where person_id is not null;

create or replace function public.nf_my_person_id() returns uuid
language sql stable security definer set search_path = public as
$$ select person_id from user_roles where user_id = auth.uid() $$;

create or replace function public.nf_is_own_person(p uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select p is not null and exists(
     select 1 from user_roles where user_id = auth.uid() and person_id = p) $$;

drop policy if exists namaa_self_time_insert on public.time_entries;
create policy namaa_self_time_insert on public.time_entries
  for insert to authenticated
  with check (public.nf_is_own_person(person_id));

drop policy if exists namaa_self_time_update on public.time_entries;
create policy namaa_self_time_update on public.time_entries
  for update to authenticated
  using (public.nf_is_own_person(person_id))
  with check (public.nf_is_own_person(person_id));

-- plus: nf_admin_set_user(...), the capture-guard trigger function, and
--       trg_time_entries_capture_guard (section 3.4).
```

Before this becomes `supabase-0021-*.sql` it needs: the trigger body, a
read-only preflight, an idempotent re-run check, and the tests in section 6.
