# DABWORKS Finance — development plan and handoff

Written 2026-11-14 for whoever continues this work (human or model). It assumes
you have **not** seen the conversations that produced it. Read sections 1–5
before touching anything; they are short and each line is there because
something went wrong without it.

Status of every fact below: verified against the repository on 2026-11-14
unless marked **(unverified)**.

---

## 1. What this is

**DABWORKS Finance** is a bilingual (Arabic RTL / English LTR) project-finance
application for an MEP engineering design office. It tracks clients, projects,
contracts, payment certificates, incoming payments, expenses, team assignments
and time. It was called "MEP Finance", then "NAMAA Finance", and was rebranded
to DABWORKS in November 2026 — **display name only** (see section 3.2).

| | |
|---|---|
| Repository | `C:\Dev\Namaa-finance`, GitHub `mdabbo/Namma-Finance` |
| Version | 0.7.1, channel Beta, schema 29 (`release/release.json`) |
| Desktop | Tauri v2 — Rust backend in one file, React 19 + TypeScript WebView, SQLite via sqlx |
| Core | `packages/core` (`@mep/core`): UI-free financial engine, shared by desktop and mobile |
| Mobile | `apps/mobile`: Expo SDK 54, React Native, **read-only**, talks to Supabase |
| Cloud | Supabase Postgres, two-way offline-first sync from the desktop |
| Package manager | pnpm 10.0.0 (pinned). Node 24. Rust 1.97.1 MSVC |
| Owner | Muhammad Dabbous — works in SAR and EGP; reports in SAR |

Sizes worth knowing: `apps/desktop/src-tauri/src/lib.rs` is 9,620 lines with 45
Tauri commands; latest migration is `0007_special_person_payments.sql`; i18n has
831 keys in each of `en.ts` and `ar.ts`.

### Where things stand on 2026-11-14

- `origin/main` is at `3f5300d` (merge of PR #17). The post-merge `Quality
  gates` runs on `main` are green: #54 (`532a98b`) and #56 (`3f5300d`). The red
  run #51 (`e7341a5`, September) was the last failure.
- Phase A (below) is merged.
- **Phase B0, 2026-11-15** — local `main` updated; CI on `main` checked (green);
  two branches committed locally, **not yet pushed**:
  - `ci/pin-rust-toolchain-v2` (`f0dc98c`) — the toolchain pin replayed onto
    current `main`, plus a guard test in `ci-workflow.test.ts`. Supersedes the
    old `ci/pin-rust-toolchain` (`8d1adf1`), whose temp worktree had been
    partly deleted by Windows and was removed.
  - `chore/brand-strings` (`177221b`) — `version:check` reads the product name
    from `tauri.conf.json`; changelog intro renamed; two tests.
  - B0 item 5 (correct `KNOWN-LIMITATIONS.md`) waits on decision 9.
- This file is **uncommitted**. Commit it through a PR if you want it kept.

---

## 2. Rules that are not negotiable

These come from the owner. Each has cost real time when broken.

1. **Do not merge into `main` yourself.** Open a PR; the owner merges. He has
   overridden this explicitly twice ("merge it") — only then.
2. **Do not change unrelated behaviour.** A fix touches what it fixes.
3. **Money is integer minor units. Never floating point.** Rates are basis
   points; FX rates are micro-units (EGP per major unit × 1,000,000).
4. **Rust owns every production multi-statement transaction.** The WebView must
   not issue `BEGIN`/`COMMIT`/`ROLLBACK`. Multi-table writes go through a
   `*_atomic` Tauri command via `atomicCommand(...)` in `src/lib/atomic.ts`.
5. **The TypeScript test double must behave like the Rust path.** Tests and E2E
   run against the double; if they drift, green tests prove nothing.
6. **Never manufacture financial records or statuses.** Statuses are derived
   from stored evidence. Do not silently turn an unknown value into zero.
7. **Preserve archive, void, reversal and audit-history semantics.**
   `audit_logs` is append-only by trigger.
8. **A regression test for every defect fixed — and prove it fails.** Reintroduce
   the defect, watch the test go red, restore. Two tests written in this project
   passed against the bug they were meant to catch until this was done.
9. **Do not claim tests passed unless you ran them**, and say which commit.
10. **Arabic RTL and English LTR must both keep working.**
11. **One focused commit per milestone**, then report: files changed, design
    decisions, tests added, commands run, exact results, remaining risks, SHA.
12. **Commit or push only when asked.** Stop after a milestone; do not roll on
    to the next one.

### 2.1 Things that destroy data if you get them wrong

- **Never edit an applied migration** (`apps/desktop/src-tauri/migrations/*.sql`),
  not even a comment or a line ending. sqlx stores a checksum of each file in
  every installed database; a change makes the app refuse to open existing
  data. `.gitattributes` pins their line endings for this reason. Add a new
  numbered migration instead (next is `0008`).
- **The owner's live database is on this machine** under
  `%APPDATA%\com.mepfinance.app`, behind MSIX copy-on-write virtualisation.
  Never run destructive SQL against it. For diagnostics use `VACUUM INTO` or a
  backup copy. For development runs use the dev config, which has its own
  identifier and therefore its own database:

  ```bash
  pnpm --filter @mep/desktop exec tauri dev --config src-tauri/tauri.dev.conf.json
  ```
- **A schema bump is three edits that must agree**: `release/release.json`
  `schemaVersion`, `CURRENT_SCHEMA_VERSION` in `lib.rs`, and the new migration's
  `PRAGMA user_version` (plus its `app_metadata` row). `pnpm version:sync`
  writes the first two; `scripts/sync-version.test.mjs` asserts all three.

### 2.2 Identifiers that must keep the old names

The rebrand changed what the user sees, nothing that is stored. Renaming any of
these breaks existing installs or the live cloud project:

- `com.mepfinance.app` (Tauri identifier — it keys `%APPDATA%`)
- comments inside migrations `0001`/`0002` that say "NAMAA"
- the Supabase bucket `namaa-documents`, the `namaa_*` RLS policies and
  `namaa_protect_*` functions
- mobile AsyncStorage keys `namaa.*` and the Expo slug `namaa-finance`
- package names `@mep/*`, the repository path and GitHub repo name
- `.namaa-part` / `.namaa-old` temp-file extensions in `lib.rs`

---

## 3. The brand

The **only** authoritative source is the package at
`D:\NAMAA\Dabworks\Dabworks\claude\DABWORKS_Brand_System`. Its token file is
`04_Digital_Identity/Website/dabworks-brand.css`.

| Token | Value | Use in the app |
|---|---|---|
| Deep Navy | `#0B2545` | `brand-600`: primary buttons, links, active nav, focus |
| DAB Orange | `#F36C21` | accent **fills** only: logo slash, cash-out series, progress |
| Ink / Mist | `#1C2433` / `#F3F5F8` | text / canvas |
| Stone / Charcoal | `#C9CED6` / `#3F3F3F` | borders / secondary |
| Type | Montserrat (headings), Inter (body), Tajawal (Arabic) | self-hosted via `@fontsource` |

Two decisions the owner made, with the reason:

- **Navy drives actions, not orange.** The package's own `.btn-primary` is white
  on orange, which measures 3.0:1. `--ui-accent-text` (`#C64F0C`) exists for
  small orange text on light surfaces.
- **`brand-600` and `brand-700` are theme-aware** (`--ui-brand-600/700`). Navy is
  the dark-mode surface colour, so a fixed navy made buttons, links and a chart
  series invisible in dark mode. Check dark mode whenever you touch colour.

Do **not** use the "DABWORKS Logo" design canvas or
`D:\NAMAA\DABWORKS Engineering Brand Identity Board.png`. Both are superseded
explorations with different palettes; a full pass was once built from the wrong
one and had to be redone.

Fonts must be bundled: the CSP allows `font-src 'self' data:` only.

---

## 4. How to work here

### 4.1 The loop for every change

1. `git fetch origin`, branch from `origin/main`.
2. **Confirm the problem still exists** on current `main`. One Phase A item had
   already been fixed by an earlier release; the document describing it was
   stale. Read the code, not the notes.
3. Write the failing test first where you can.
4. Fix it. Keep the diff to the subject.
5. **Negative test**: reintroduce the defect, confirm the new tests fail, restore.
6. Run the gate (4.2). Report real numbers.
7. One commit, then a PR. The owner merges.

### 4.2 The gate

```bash
pnpm install --frozen-lockfile
pnpm version:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @mep/desktop test:e2e
```

Baseline on `main` today: lint 0 errors with 2 known `react-hooks/exhaustive-deps`
warnings; core 246 tests; desktop 471 tests; core coverage 96.99%; 61 Rust
tests; Playwright 154 passed, 2 skipped (both are a 1366-only layout test
skipping on the other two viewports).

CI (`.github/workflows/quality.yml`, "Quality gates") runs four jobs on every
PR: `TypeScript and unit tests`, `Rust quality`, `Playwright E2E`,
`Desktop production build`. `main` is protected by a ruleset requiring all four.
A count of "4 passing" is not enough — confirm none was skipped, and that the
result is for your head SHA and not a cached earlier one.

### 4.3 Traps in this environment

Every one of these has already happened.

- **`gh` is not authenticated** and `gh auth login` is interactive, so it cannot
  run from an agent session. PRs were opened and merged through the owner's
  Chrome (Claude in Chrome extension), where he is signed in to GitHub. Ask him
  to run `gh auth login` once in a real terminal; it removes this whole problem.
- **Filling the GitHub PR form through the browser**: setting the title through
  the form API wrote to a hidden field once, and clicking the title by
  coordinates landed in the description once. Click fields by element
  reference, then **look at both fields before pressing Create**.
- **Line endings are CRLF** in most source files. Multi-line search-and-replace
  must convert `\n` to `\r\n` or it silently matches nothing. Make every scripted
  replacement assert exactly one match and abort otherwise.
- **Ports 1420 and 1425.** `tauri dev` starts Vite on 1420; killing the app and
  cargo leaves Vite alive. Playwright reuses an occupied port instead of
  starting its own server, and then every E2E test fails against a server with
  no test database. Check both ports are free before an E2E run; kill by port.
- **`pnpm --filter x test:e2e -- --update-snapshots` does not work**: pnpm 10
  passes the `--` through and Playwright ignores the flag. Use the script
  `test:e2e:update`.
- **Visual baselines**: two of them (`payment-form`, `finance-workspace`) embed
  today's date. They pass through a 2% pixel tolerance. Do not regenerate
  baselines unless you changed how something looks; if E2E passes against the
  existing baselines, leave them.
- **A known flaky E2E test**: `project-workspace.spec.ts:81` failed 1 run in 24
  on untouched `main` — "Load demo workspace" never appears. Most likely a
  previous test's page is still writing when the next test resets the database.
  CI retries once. Do not attribute it to your change without checking.
- **The E2E suite shares one database across tests.** A test that changes the
  language or leaves data behind breaks the next one. Reset what you change.
- **Creating a file can overwrite one.** `packages/core/tests/valuation.test.ts`
  already existed and was overwritten by a new file of the same name (restored
  from git). Check before you create.
- **"valuation" means two things in the core.** `calc/valuation.ts` is contract
  valuation *mode* (lump sum / milestones / drawings).
  `money/currencyValuation.ts` is the reporting-currency rule from Phase A.
- **Python is not installed.** Use Node for scripts.
- **A stash exists that nobody in this plan created**: `stash@{0}: On main:
  wip-claude`. Ask the owner before touching it.
- **Never keep work in a worktree under `AppData\Local\Temp`.** Windows deleted
  files from one used here (`ci/pin-rust-toolchain`). Its folder also hit the
  260-character path limit, so `git worktree remove` failed and it had to be
  deleted with PowerShell's `\\?\` long-path prefix. Branch in the main
  checkout instead.

---

## 5. Decisions only the owner can make

Do not start the step that depends on one of these until it is answered.

| # | Question | Blocks |
|---|---|---|
| 1 | Launcher gate screen, or a Home page with everything visible? (Recommendation: Home.) | E1 |
| 2 | Do document files live in the app, or stay in Google Drive with the app holding the register? (Recommendation: Drive.) | E2 |
| 3 | During the document-control transition, which is authoritative — the spreadsheets or the app — and when do the spreadsheets stop? | E2 |
| 4 | What is actually wrong with the current mobile app? The owner reported "a lot of errors" in July 2026 and the list was never captured. | F1 |
| 5 | Is document control for the office only, or will clients and contractors see it? | E2, F |
| 6 | Which legal entity issues invoices, and in which country? That decides whether Saudi e-invoicing (ZATCA) applies. Ask him to confirm with his accountant. | D2 |
| 7 | Should backups be encrypted with a password he must remember? Losing it loses the backup. **Answered 2026-11-25: no — B2 is skipped. Do not re-propose it unless the owner raises it.** | B2 |
| 8 | Will he buy a code-signing certificate? Without one the installer stays "Beta" and SmartScreen warns. | B5 |
| 9 | Is `supabase-security-hardening.sql` applied to the live Supabase project? See 5.1. | F0 |

### 5.1 A contradiction you must resolve before any mobile work

`docs/KNOWN-LIMITATIONS.md` says role enforcement is client-side and "per-role
row-level security is not yet implemented". But `docs/supabase-security-hardening.sql`
defines exactly that — `nf_can_manage_finance()` (ADMIN, ACCOUNTANT) and
`nf_can_engineer_write()` — and `docs/PHASE3-SETUP.md` lists it as step 6.

One of the two is stale. **Which one is deployed is unverified.** Find out by
running `docs/supabase-cloud-preflight.sql` (read-only) with the owner, then
correct whichever document is wrong.

Under the hardening script as written, an ENGINEER may write only
`project_stages` and `documents`. **Time entries require a finance role** — which
matters for the mobile plan.

---

## 6. Phase A — trust the numbers (DONE, merged in PR #17)

Recorded so you know what changed and what was deliberately left.

**Consolidated figures now hold face value.** A SAR 325,000 contract on a SAR
dashboard read SAR 317,031.19: figures were summed in EGP at each record's
stored rate, then converted back at today's rate. This was a regression — fixed
in the view in July (`e585393`), lost when the dashboard maths moved into the
core (`80cb923`), with no test to notice.

The rule now lives in `packages/core/src/money/currencyValuation.ts`: each source
amount is valued once, per record — at face value if it is already in the
reporting currency, through the EGP pivot otherwise. `aggregate`, `cashValuation`
and `dashboard` take a **required** `CurrencyValuation`. The desktop loads the
workspace with it (`useWorkspaceFinancials`, `useReportingValuation`); views only
format. `useBaseMoney` deliberately has no `convert`.

**Printed documents name the office.** Certificates, team statements and reports
print `settings.companyName` through `src/lib/issuer.ts`, falling back to the
product name only when none is set.

**The third planned item was already fixed.** The "sync bypasses the certificate
lifecycle gate" limitation from the 0.7.0 notes was closed in 0.7.1 by
`apply_synced_certificate_transaction`.

Left over from Phase A, on purpose:

- **Fields named `…Egp` now hold amounts in the reporting currency.** They are
  documented at the type definitions. About 550 identifiers; rename in its own
  mechanical commit (step C2).
- `pnpm version:check` still prints "NAMAA Finance" (`scripts/sync-version.mjs:78`),
  and `CHANGELOG.md` opens with "NAMAA Finance".
- Guard tests in `apps/desktop/test/reporting-currency.test.ts` fail if desktop
  code calls `toEgpPiasters`/`fromEgpPiasters` or uses `EGP_VALUATION` outside
  `repositories/financials.ts`. That is intended; do not relax them.

---

## 7. Phase B — survive a bad day

Goal: when something goes wrong, the owner can tell what happened and get his
data back. Do this before adding features — every new module raises the cost of
an unrecoverable failure.

### B0. Housekeeping (small, do first)

1. Bring local `main` up to date: `git checkout main`, `git pull --ff-only`.
2. Check the `Quality gates` run on `main` for `3f5300d`. `main` was red from
   2026-09-02 on a `cargo test` failure that never reproduced locally (61 tests
   pass) and whose triggering commit changed no Rust code. Record whether it is
   green now.
3. Open a PR for `ci/pin-rust-toolchain` (`8d1adf1`). It pins Rust to 1.97.1 via
   `rust-toolchain.toml` so the compiler is part of the commit; without it a
   toolchain change and a flaky test look the same. Rebase onto current `main`
   first.
4. Fix the two leftover brand strings (section 6). Add an assertion to
   `scripts/sync-version.test.mjs` that the script's output names the product.
5. Correct `docs/KNOWN-LIMITATIONS.md` once decision 9 is answered.

*Done when*: `main` is green and stays green on a re-run; one PR each for 3 and 4.

### B1. An error boundary and a log file

Today a render error blanks the window, and failures reach only the WebView
console. Neither `ErrorBoundary` nor a logging plugin exists.

1. Add a React error boundary around the router in `apps/desktop/src/main.tsx`
   (and one per route via `errorElement`). It should show what failed, offer
   "Reload" and "Copy details", and never show financial data in the details.
2. Add `tauri-plugin-log` (Rust + JS), writing a rotating file under the app's
   log directory. Route `console.error` call sites and Rust command errors to it.
3. Add "Open log folder" under Settings → System → Advanced.
4. Log **no** amounts, client names or credentials. Write a test that scans the
   logging call sites for interpolated money fields.

*Tests*: a component test that a throwing child renders the fallback (the repo
already renders components with `renderToStaticMarkup` in
`test/design-system.test.ts`); an E2E test that a forced error shows the
fallback and the sidebar still works. Both languages.

*Risk*: the CSP and Tauri capability file must allow the log plugin; check
`src-tauri/capabilities/`.

### B2. Encrypted backups (SKIPPED — owner decided 2026-11-25 not to encrypt backups)

The SQLite file and its backups are unencrypted, and backups are copied to a
user-chosen folder that is in practice a Google Drive folder. The app lock
(Argon2id) protects the screen, not the file.

1. Decide scope with the owner. Recommended: **encrypt backup files**, leave the
   live database alone for now. Encrypting the live database (SQLCipher) changes
   how sqlx opens it and how every backup/restore path works — a much larger
   change with its own migration story.
2. Implement in Rust, in the existing backup commands (`create_backup_file`,
   `validate_backup`, the restore path): password-derived key (Argon2id, which is
   already a dependency), authenticated encryption, a clear header so an
   encrypted backup is recognisable and versioned.
3. Restore must fail closed with a specific error on a wrong password, and must
   never leave a half-written database — reuse the existing staged/previous file
   swap.
4. Keep reading unencrypted backups.

*Tests* (Rust, in the existing style — `#[test] fn x() { tauri::async_runtime::block_on(async { … }) }`):
round trip; wrong password; truncated file; tampered byte; unencrypted legacy
backup still restores.

*Risk*: a forgotten password is permanent data loss. The UI must say so in both
languages before the owner turns it on.

### B3. Releases you can reproduce

There are no git tags for 0.7.0 or 0.7.1 — only `pre-db-rebase-v0.6.7` and
`pre-ui-redesign-v0.6.0` — and the version is still 0.7.1 after a rebrand and a
reporting change.

1. Bump to **0.8.0** with `pnpm version:sync` after editing `release/release.json`.
   No schema change, so `schemaVersion` stays 29.
2. Move the `[0.7.1] - Unreleased` changelog section under 0.8.0 with a date.
   State plainly that consolidated totals for non-EGP reporting currencies
   differ from 0.7.x.
3. After the release PR is merged and green, ask the owner to tag `v0.8.0` on
   that merge commit (or do it when asked).
4. Add `docs/releases/0.8.0/` following the 0.7.0 folder. A local gate run is not
   release evidence; the CI run for the released commit is.

### B4. Make the E2E suite trustworthy

1. Reproduce the flake: `pnpm --filter @mep/desktop exec playwright test
   project-workspace -g "navigates from a project activity row" --repeat-each=30`.
2. Test the hypothesis that a previous page's in-flight writes land after the
   next test's reset. If so, have the fixture close or quiesce the page before
   resetting, or have the bridge reject writes from a superseded session.
3. Replace bare `.count()` checks followed by `test.skip` with a bounded wait —
   a skip that depends on render timing hides a test.
4. Give `payment-form` and `finance-workspace` a fixed clock so the baselines
   stop depending on the date.

*Done when*: 100 consecutive passes of the affected specs locally.

### B5. Signing and updates (needs decision 8)

1. With a certificate: sign the NSIS installer in the `Desktop production build`
   job; follow `docs/releases/0.7.0/WINDOWS-CODE-SIGNING.md`.
2. Then add `tauri-plugin-updater` with a signed update manifest. Do not add an
   updater to an unsigned app.
3. Until then the channel stays **Beta** — that rule is already in the docs.

### B6. Acceptance that has never been repeated

- `docs/TWO-PC-SYNC-ACCEPTANCE.md` has not been run against current builds. It
  needs two machines and the owner.
- A clean-machine install of the packaged app has never been done. No automated
  test drives the packaged binary — E2E runs the WebView against the TypeScript
  double.

---

## 8. Phase C — structure

Order matters here: C1 first, because it is the only item that cannot be
backfilled.

### C1. Progress history (new migration `0008`)

`project_stages.completion_bp` is a single mutable value. Once changed, the old
value is gone: no S-curve, no progress-over-time, no proof of what was reported.

1. Migration `0008`: an append-only `stage_progress_log` (stage id, completion
   bp, recorded at, source, sync uuid) with update/delete-blocking triggers in
   the style of `audit_logs`. Bump schema to 30 (three places, section 2.1).
2. Write the log row **in the same Rust transaction** that changes
   `completion_bp`. Find every writer of that column first — including the sync
   pull path and the import wizard.
3. Mirror it in the TypeScript test double.
4. Add the table to the sync registry and to the Supabase schema as a new delta
   script; classify it in `SYNC_TABLE_POLICIES` in `lib.rs` (a test asserts every
   mutable table is classified).
5. No UI yet. This step only starts collecting.

*Tests*: a row per change; none when the value is unchanged; the log cannot be
updated or deleted; fresh-database baseline test still passes.

### C2. Rename the `…Egp` fields

Pure rename, no behaviour change, in its own PR: about 550 identifiers across
`packages/core`, `apps/desktop`, `apps/mobile` and their tests. Suggested suffix
`Reporting` (not `Base` — `baseMinor` already means the pre-VAT amount). The
type checker catches every miss in `src`; desktop **tests are not type-checked**
(`tsconfig` includes only `src`), so run them.

### C3. Split `lib.rs`

9,620 lines in one module. Split by domain (`certificates`, `payments`, `sync`,
`backup`, `security`, …) with `lib.rs` keeping only registration. Move code, do
not rewrite it; keep the tests with what they test. One domain per PR. `cargo
test` count must stay at 61.

### C4. Split the bundle

One 2.06 MB JavaScript chunk. Lazy-load routes in `main.tsx` with `React.lazy`.
Check the lock screen and the startup-compatibility error path still render
without the lazy chunks.

### C5. Finish the design tokens

Only about a quarter of the UI uses tokens: 336 hardcoded `slate/gray` utilities
against 103 token uses, so the brand neutrals do not reach most screens.
`text-slate-400` appears 77 times and measures about 2.6:1 on white.

1. Map each slate utility to a token (`text-muted`, `bg-surface-subtle`,
   `border-border-subtle`, …). Check contrast for every pairing in both themes
   before writing it.
2. One feature area per PR, regenerating only the baselines that changed.
3. Add a guard test that fails on new hardcoded slate utilities.

### C6. A test for translation parity

`en.ts` and `ar.ts` match today (831 keys each) but nothing enforces it. A
missing key renders as the literal key on screen. Add a core test comparing the
key sets, and one listing Arabic values identical to English ones against an
allowlist (currently `appName`, `English`, and one interpolation template).

### C7. Tests for the mobile app

It has none. Start with the pure parts: `src/lib/workspace.ts` mapping (uuid rows
to the core engine) against fixtures.

---

## 9. Phase D — product gaps

### D1. A demo block that can be found

"Remove demo data" lives on Settings → Data → Import & utilities and renders only
when a demo workspace exists, so it cannot be discovered. Replace it with one
always-visible block: **Load** when none exists, **Remove** when one does. Keep
the confirmation dialog.

### D2. Tax invoice (needs decision 6)

The app has certificates but no tax invoice. The brand package includes a
bilingual invoice template with ZATCA fields. If the issuing entity is
KSA-registered, Phase 2 e-invoicing rules may apply (QR code, XML, clearance) —
that is a compliance project, not a template. Scope it with the owner's
accountant before designing anything. VAT is already per contract (`vat_bp`).

### D3. Quotations and the pre-contract pipeline

Nothing exists before a contract. Add quotations (number, client, value,
status, validity) that convert into a contract. Read-only derivation of win rate
and pipeline value.

### D4. Budget versus actual

No budget concept exists. Per project: a budget by expense category, compared
with actual paid cost, accrued cost and commitments, which `costsByProject`
already separates.

---

## 10. Phase E — one app, three areas

The owner wants document control and project tracking alongside finance, and
first imagined a launcher that makes you choose a module. Background, which
changes the plan:

- **Finance is a real system of record.**
- **Document control does not exist as software.** Today it is Excel logs in
  Google Drive plus a dashboard that reads them — "CASA Shop Drawing Tracker"
  (`https://claude.ai/artifact/2RjutMpCV466mfziuSNnAp`) over
  `43008-CASA-Shop-Drawing-Log-rev01.xlsx`, and the MISK joinery logs (242
  sheets, 11 BIM prototypes). A dashboard shows what he looks at, not what he
  needs to record; do not treat it as a specification.
- **Project tracking is half-built inside finance**: `project_stages` (status,
  `completion_bp`, dates, engineers), a nine-stage template, a Gantt view,
  milestone-linked certificates, time entries.

The earlier plan document is at
`https://claude.ai/artifact/6gNKWisvjbf2aXcRxiEQWW`.

### E0. Decide (no code)

Answer decisions 1, 2, 3 and 5. Walk the existing stages and Gantt with the
owner and write down what tracking already covers, so nothing is built twice.

### E1. The shell (no schema change)

1. A **Home** page with live counts across finance, documents and delivery:
   what is overdue, what needs him today. Not a gate — every area stays one
   click away in the sidebar.
2. Add **Documents** and **Delivery** to the sidebar (`src/app/navigation.ts`).
3. Keep **one** Settings, grouped by area. `test/settings-navigation.test.ts` and
   the E2E spec assert that no group label equals a section label; extend the
   groups, do not weaken the tests.
4. If the owner still wants a chooser, make it a preference ("Open on: Home /
   Finance / Documents"), never a wall.

Recommendation and reason, to give him: the three areas are views of one object,
the project. Drawing approved → milestone released → certificate issued → payment
received crosses all three; a gate hides exactly those links.

### E2. Document control as a system of record

The largest piece of new work. Design the schema on paper first — migrations are
permanent.

1. **Schema** (one or more new migrations): a document register (number unique
   per project, title, discipline, type), **append-only revisions** (a revision
   is superseded, never overwritten — the reason spreadsheets fail), transmittals
   and their items, review cycles (submitted → under review → code A/B/C/D →
   resubmitted), and an RFI register. Status is **derived** from the latest
   review record, never typed in. The existing `documents` and `document_cache`
   tables are a file registry; decide whether revisions reference them.
2. **Rust commands** for every multi-table write (issue a revision, send a
   transmittal, record a review), each with a TypeScript double and tests on
   both sides.
3. **Audit and sync**: write through `audit_logs`; add every table to the sync
   registry, the Supabase schema and `SYNC_TABLE_POLICIES`; decide conflict
   behaviour for each (revisions are evidence — treat like certificates).
4. **Importer** from the existing Excel logs, modelled on the import wizard. It
   must be re-runnable without creating duplicates, and report what it skipped.
5. **UI**: register with filters and saved views, document page with revision
   history, transmittal builder, review log, RFI list; a Documents tab on the
   project page.
6. **Files**: if they stay in Drive (recommended), store a link and a hash, not a
   copy.

Plan this as several milestones — schema, commands, importer, UI — not one push.

### E3. Tracking gaps

Uses the history that C1 has been collecting.

1. **Baseline**: freeze planned dates when the contract is approved; "planned vs
   actual" today compares the plan with itself.
2. **S-curve** from `stage_progress_log`.
3. **Lookahead**: what is due in the next three and six weeks.
4. **Resource loading** from assignments and time entries.

### E4. The links between areas

This is the reason to combine them at all.

- Drawing approval releases a milestone: a milestone cannot be certified until
  its drawings carry an approval record. This is a **financial rule** — enforce
  it in the Rust certificate commands, not in the view.
- A "blocked certificates" list: revenue that cannot be invoiced yet, and which
  drawing is holding each line.
- The trail from transmittal to payment in one view.
- Progress beside certified beside collected, per project.
- Open RFIs ageing against the programme.

---

## 11. Phase F — Android

### 11.1 Where it stands

`apps/mobile` is an Expo SDK 54 app (React Native, React Navigation, React
Query, `@supabase/supabase-js`, AsyncStorage). Five screens: Setup, Home,
Projects, ProjectDetail, Settings. It is **read-only**: it signs into the
owner's Supabase project, maps uuid rows to the same `@mep/core` engine
(`src/lib/workspace.ts`) and shows EGP-consolidated KPIs.

Known limits: Arabic renders with LTR layout; no standalone APK (it runs in Expo
Go); no tests; the owner reported "a lot of errors" in July that were never
written down. It was pinned to SDK 54 because that was the newest SDK the public
Expo Go client supported. `apps/mobile/AGENTS.md` says to read the versioned Expo
docs before writing any Expo code — do that.

### 11.2 The constraint that shapes everything

The desktop enforces the financial rules in Rust, inside transactions:
allocation capacity, certificate lifecycle, cross-contract rejection, FIFO
allocation. **A phone writing to Supabase passes through none of it.** The cloud
has row-level security and some integrity constraints (a unique allocation
index, protection of approved contract revisions), not the financial logic. A
bad row written from a phone would be rejected by each desktop when it pulls —
kept as a `REMOTE_DOMAIN_REJECTED` conflict — but it would still be sitting in
the cloud.

So there are two honest designs:

1. **The phone captures; the desktop decides.** Mobile writes only what cannot
   corrupt the ledger.
2. Re-implement the financial rules in Postgres so both clients share one
   enforced path — a third implementation, in a third language, to keep
   identical to the Rust and TypeScript ones.

**Build the first.** It also matches how the work divides: the site captures,
the office decides.

| Safe to write from the phone | Desktop only |
|---|---|
| Time entries | Certificates |
| Expense capture with a photo | Payments and allocations |
| Drawing received / document status (after E2) | Contract revisions, variation orders |
| Site photos against a project | Team payments — except earned payments capped at due, which the phone may record (owner decision 2026-11-25; see PHASE4-MOBILE.md) |
| Requests for approval | Anything touching two or more financial tables |
| Everything read-only | |

### 11.3 Steps

**F0. Server prerequisites — before any phone can write.**
1. Resolve section 5.1: establish which RLS policies are live. Started
   2026-11-16: `docs/supabase-policy-preflight.sql` (read-only) is written;
   the owner has not yet run it. **Owner decision 2026-11-16: each engineer
   gets their own Supabase login** (not the shared office login), so policies
   can key on `auth.uid()`. `people` has no auth-user column today.
   **Preflight result, 2026-11-16 (decision 9 answered):** the hardening
   script IS live. Every app table has RLS on, `namaa_member_read` for
   members, and `namaa_finance_write` (ADMIN, ACCOUNTANT) — except
   `project_stages`, `documents` and `stage_progress_log`, which carry
   `namaa_member_write` (adds ENGINEER). No `office_all` policy remains
   anywhere. `docs/KNOWN-LIMITATIONS.md` ("Role enforcement is client-side")
   is the stale document. Also found: `user_roles` holds exactly one login
   (ADMIN); `sync_peers` (optional delta 0018) was never applied; storage
   policies on `namaa-documents` scope read AND write to the uploader's own
   folder, so an accountant cannot open a photo an engineer uploads — F6
   needs a finance-role read policy.
   **F0.2 design, 2026-11-16:** `docs/F0-MOBILE-WRITE-POLICIES-DESIGN.md`
   (design only, nothing applied). It puts the login-to-person link on
   `user_roles.person_id` — cloud only, so no desktop migration for time
   entries — and splits the work into three deltas: A link + own time
   entries, B engineer read scope, C expense claims (needs migration `0009`).
   Four owner decisions in its section 8 block the SQL. Answered so far:
   B — engineers MAY read money data, so delta B is dropped. A — an
   engineer may add or change own time entries dated within the last 14
   days. C and D still open.
   **Delta A written 2026-11-17, NOT applied to the live project:** branch
   `feat/f0-time-entry-policies` (uncommitted) holds
   `docs/supabase-0021-time-entry-capture.sql`, `docs/supabase-0021-preflight.sql`
   and `apps/desktop/test/cloud-policies.test.ts` (48 tests; the real cloud
   scripts run unmodified in PGlite, added as a desktop dev dependency). 31
   reintroduced defects each turned the suite red. Next: owner runs the
   preflight, applies 0021, links the first engineer (decision D); then F5.
2. Under the hardening script an ENGINEER cannot write `time_entries` or
   `expenses`. Design narrower policies: an engineer may insert **their own**
   time entries and expense claims, and edit them only until an accountant
   approves. That needs a link from the auth user to a `people` row — check
   whether one exists; if not, it is a schema change on both sides.
3. Expense capture from the phone should create a **claim** for the desktop to
   accept, not a posted expense. A posted expense affects profit; a claim does
   not until someone approves it. This keeps the ledger desktop-owned.
4. Ship each change as a new numbered `docs/supabase-00NN-*.sql` delta with a
   read-only preflight, as the existing ones do. Never edit an applied script.

**F1. Stabilise what exists.**
1. Get the error list from the owner (decision 4). Reproduce each on a device.
2. Fix them. Add tests for the workspace mapping (C7).

**F2. Arabic and RTL.**
React Native needs `I18nManager.forceRTL` plus an app restart to flip layout.
Decide the behaviour (restart prompt on language change), then check every
screen in Arabic. Use Tajawal for Arabic and the brand tokens from
`src/lib/theme.ts`.

**F3. A standalone build.**
Expo Go is a development harness, not a way to give someone an app.
1. Set up EAS (`eas.json`) with an internal distribution profile producing an
   APK. No Play Store needed.
2. Once off Expo Go, the SDK 54 pin has no remaining reason — but upgrade in its
   own change, after the build works.
3. The Supabase URL and anon key are entered at setup and stored on the device;
   keep it that way. Never commit them.

**F4. An offline queue.** — BUILT 2026-11-20 on `feat/f5-mobile-time-entries`
(`apps/mobile/src/lib/timeQueue.ts`, tests in
`apps/desktop/test/mobile-time-queue.test.ts`). Not yet tried on a phone.
Site signal is unreliable, so writes must queue.
1. Queue in local storage with a client-generated uuid per record — the cloud
   tables already use uuid keys, so a retried insert is idempotent rather than a
   duplicate. Without this, one retry becomes two time entries.
2. Show queue state clearly: pending, sent, rejected, with the reason.
3. Server timestamps decide ordering; the existing last-write-wins guard
   (`nf_lww_guard`) rejects stale updates.

**F5. Time entries** — BUILT 2026-11-20 with F4 (Time tab,
`apps/mobile/src/screens/TimeScreen.tsx`). Needs a new APK (adds
`expo-crypto`). The first write feature. Person, project, date, minutes,
note. Validate with the same core schemas the desktop uses.

**F6. Expense claims with a photo.** — BUILT 2026-11-25 in two parts (owner: claim
flow, receipt optional).

Part 1, cloud + desktop review (PR #39, merged): `docs/supabase-0025-expense-claims.sql`,
desktop migration `0010` (schema 32), `accept_expense_claim_atomic` /
`reject_expense_claim_atomic`, Finance → Expense claims. Decided claims are
content-immutable for every login (stricter than F0 design 5.2, so a late phone
edit cannot disagree with the expense).

Part 2, phone capture (PR #41): Claims tab, optional photo compressed and
hashed on the phone, uploaded before the claim through the outbox
(`expense_claims` added to OUTBOX_TABLES).
Camera capture, upload to Supabase storage under the user's folder (the
`namaa-documents` bucket policies already scope by `auth.uid()`), then the claim
row. Compress images on the device.

**F7. Reading in the reporting currency.**
The phone shows EGP because the display-currency setting is local to the
desktop. Either sync that setting or add one on the phone, then pass
`reportingValuation(...)` instead of `EGP_VALUATION` in `src/lib/workspace.ts`.
The rule and its tests are already in the core.

**F8. Document status and site photos** — only after E2 exists.

**F9. Acceptance on real devices.**
Two phones and a desktop: offline capture, reconnect, sync, desktop pull,
conflict, rejected claim. Write it up like `docs/TWO-PC-SYNC-ACCEPTANCE.md`.

### 11.4 What "done" means for mobile

- An installable APK, not Expo Go.
- Arabic is right-to-left on every screen.
- A time entry made with no signal arrives exactly once.
- An engineer's login cannot write anything in the "desktop only" column — proven
  by a test against the policies, not by the UI hiding a button.
- Nothing the phone writes changes a certified, invoiced or paid figure until the
  desktop accepts it.

---

## 12. Suggested order

1. **B0** housekeeping, **B1** error boundary and log.
2. **C1** progress history — small, and every day without it is history lost.
3. **B3** release 0.8.0, **B4** E2E reliability.
4. **B2** / **B5** when their decisions are made.
5. **C2–C7** structure, interleaved.
6. **D1**, then the rest of D as the owner prioritises.
7. **E0 → E1 → E2 → E3 → E4**.
8. **F0 → F9**. F0–F4 can start before E; F8 cannot.

No durations are given here on purpose. Size each phase when its open decisions
are answered.

### 12.1 Which model for which step

Chosen to spend the expensive models only where a mistake costs money or data.
Switch with `/model` before starting the step.

- **Opus 5.5** — anything that touches money rules, a migration, a Rust
  transaction, security or sync. Migrations are permanent and financial bugs
  are silent; this is where the cost is worth it. Use effort `high` on these
  steps (Opus 5.5 defaults to `medium`).
- **Sonnet 5.5** — UI, tests, refactors with the type checker as a safety net,
  build configuration, well-specified features.
- **Haiku 5.5** — mechanical, low-judgment work: version bumps, doc edits,
  write-ups, a single new test of an obvious rule.
- **Fable 5.2** — not needed by default. Keep it for a one-off second opinion on
  the E2 or F0 design if Opus leaves real doubt.

| Step | Model | Why |
|---|---|---|
| B0 remaining (push, PRs, limitations doc) | Haiku | Mechanical |
| B1 error boundary + log file | Sonnet | Standard pattern; one careful test for no money in logs |
| B2 encrypted backups | **Opus** | Crypto and restore atomicity; a mistake loses data |
| B3 release 0.8.0 | Haiku | Version sync and changelog |
| B4 E2E flake | Sonnet | Debugging; move to Opus if not found in one pass |
| B5 signing + updater | Sonnet | Configuration |
| B6 two-PC and clean-machine acceptance | — | Done by the owner; Haiku to write it up |
| C1 progress history (migration 0008) | **Opus** | Permanent migration, Rust transaction, sync |
| C2 rename `…Egp` fields | Sonnet | Large but mechanical; tests are not type-checked, so run them |
| C3 split `lib.rs` | Sonnet | Move code only; the compiler checks it |
| C4 bundle splitting | Sonnet | |
| C5 design tokens | Sonnet | Needs contrast checks, not deep reasoning |
| C6 i18n parity test | Haiku | One small test |
| C7 mobile tests | Sonnet | |
| D1 demo block | Sonnet | |
| D2 tax invoice / ZATCA | **Opus** | Compliance and money |
| D3 quotations | Opus to design the schema, Sonnet to build the UI | |
| D4 budget vs actual | Opus for the calculation, Sonnet for the UI | |
| E0 decisions | Sonnet | A conversation, no code |
| E1 shell (Home, navigation) | Sonnet | |
| E2 document control | **Opus** for schema, commands and importer; Sonnet for the UI | The largest design in the plan |
| E3 tracking gaps | Sonnet | Uses data C1 already collects |
| E4 cross-area links | **Opus** | Drawing approval gating certificates is a financial rule |
| F0 cloud policies | **Opus** | Security boundary for the phone |
| F1 fix the mobile app's bugs | Sonnet | |
| F2 Arabic RTL | Sonnet | |
| F3 EAS standalone build | Sonnet | |
| F4 offline queue | **Opus** | Idempotency; a mistake duplicates records |
| F5–F8 mobile features | Sonnet | The rules they rely on are set in F0 and F4 |
| F9 device acceptance write-up | Haiku | |

**The biggest saving is not the model.** Every turn re-reads the whole
conversation, so a long session gets more expensive with every message. Start
each step in a **fresh session**, point it at this file, and close it when the
step's PR is open.

---

## 13. Where to look

| Need | File |
|---|---|
| Rust backend, all commands | `apps/desktop/src-tauri/src/lib.rs` |
| Migrations | `apps/desktop/src-tauri/migrations/` |
| Atomic command seam | `apps/desktop/src/lib/atomic.ts` |
| Workspace read model | `apps/desktop/src/repositories/financials.ts` |
| Reporting-currency rule | `packages/core/src/money/currencyValuation.ts` |
| Consolidation maths | `packages/core/src/calc/{aggregate,cashValuation,dashboard}.ts` |
| Sync engine and registry | `apps/desktop/src/lib/sync/{engine,registry}.ts` |
| Navigation and Settings groups | `apps/desktop/src/app/navigation.ts` |
| Theme tokens | `apps/desktop/src/styles.css` |
| Brand mark | `apps/desktop/src/components/BrandMark.tsx` |
| Translations | `packages/core/src/i18n/{en,ar}.ts` |
| Test database harness | `apps/desktop/test/db-harness.ts` |
| E2E fixtures | `apps/desktop/e2e/fixtures.ts` |
| Cloud SQL, in apply order | `docs/PHASE3-SETUP.md`, `docs/supabase-*.sql` |
| Current limitations | `docs/KNOWN-LIMITATIONS.md` |
| Sync audit | `docs/SYNC-INTEGRITY-FINAL-AUDIT.md` |
| Threat model | `docs/SECURITY-THREAT-MODEL.md` |
| Mobile | `apps/mobile/src/lib/workspace.ts`, `docs/PHASE4-MOBILE.md` |
