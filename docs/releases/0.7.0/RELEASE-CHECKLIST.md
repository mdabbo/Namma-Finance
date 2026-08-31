# NAMAA Finance 0.7.0 Beta release checklist

Milestone numbering below follows the redesign brief as delivered. The brief's
own headings are numbered 0–9; where a reader counts the UX audit as milestone
1, add one to each number.

## Source and quality

- [x] Work was developed on `redesign/v0.7.0` and merged to `main` only after
      `Quality gates` was green on the released commit — see **Merge record**.
- [x] Application, mobile, core, Cargo, Tauri, and release-manifest versions are
      synchronized at 0.7.0 (`version:check` verified: **0.7.0 (Beta), schema
      27**).
- [x] Release metadata is asserted independently of the script that writes it,
      including the newest migration's `PRAGMA user_version`
      (`scripts/sync-version.test.mjs`). Before this, bumping `schemaVersion`
      without adding the matching migration passed `version:check` while
      producing a build that would refuse to open every database.
- [x] Type checking, lint, TypeScript tests, coverage, Rust gates and the
      Playwright UI suite pass **locally** on the final source tree — figures in
      `TEST-SUMMARY.md`. A local run is not release evidence; the CI block below
      is.
- [x] Every redesign milestone was followed by an independent audit pass, and
      each confirmed defect was fixed with regression coverage before the next
      milestone began.

### Local gate results

Run on Windows against the final Milestone 6 tree. **These are local
measurements and are not a substitute for the CI block below.**

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm version:check` | 0.7.0 (Beta), schema 27 — verified |
| `pnpm lint` | pass — 0 errors, 2 pre-existing warnings |
| `pnpm typecheck` | pass — 3/3 workspaces |
| `pnpm test` | pass — scripts 9, core 233, desktop 425 |
| `pnpm test:coverage` | pass — 96.88% stmts / 90.53% branches |
| `cargo fmt --check` | pass |
| `cargo clippy --all-targets -- -D warnings` | pass |
| `cargo test` | pass — 49 |
| `pnpm --filter @mep/desktop test:e2e` | pass — 148 passed, 2 skipped |
| `pnpm --filter @mep/desktop exec tauri build` | pass — NSIS installer produced |

### CI evidence (required before release)

A local pass proves nothing to anyone who was not sitting at that machine, so
the release may not claim green gates until this block is filled in from a real
GitHub Actions run on the released commit.

**Status: SATISFIED.** `Quality gates` is green on the exact released commit,
on two independent runs — the `push` run and the `pull_request` run for PR #7 —
with all four required jobs passing in both. No job was missing, skipped, or
failing.

The SHA recorded below is the commit carrying the release **code**. This
document is itself committed afterwards, so the branch head advances past it by
a documentation-only commit; that commit changes no code under test and is
re-verified by its own `Quality gates` run on the pull request. Check the PR's
latest run before merging.

- [x] `Quality gates` workflow green on the released commit — all four jobs
      (`TypeScript and unit tests`, `Rust quality`, `Playwright E2E`,
      `Desktop production build`).
- [x] Pull request number: **#7** —
      https://github.com/mdabbo/Namma-Finance/pull/7 (`main` ← `redesign/v0.7.0`,
      49 commits, 244 files, mergeable state `clean`)
- [x] Commit SHA: `da440cd0e1ff1ee330fbea8eef8eceb09666332c`
- [x] Workflow run URL (push):
      https://github.com/mdabbo/Namma-Finance/actions/runs/33385807451
- [x] Workflow run URL (pull request):
      https://github.com/mdabbo/Namma-Finance/actions/runs/33387772581

| Job | push run | PR run |
| --- | --- | --- |
| TypeScript and unit tests | success (120s) | success (97s) |
| Rust quality | success (195s) | success (474s) |
| Playwright E2E | success (554s) | success (585s) |
| Desktop production build | success (284s) | success (547s) |

- [x] Both runs uploaded all four artifacts, unexpired: `desktop-installers`
      (4.75 MB), `desktop-build-evidence`, `playwright-report`,
      `core-financial-coverage`.
- [ ] `desktop-build-evidence` **downloaded** and `release-evidence.txt` inside
      it read back to confirm it names the SHA above. Artifact download requires
      an authenticated request (the anonymous API returns 401), so this was
      confirmed only as far as the artifact's presence on the run for that SHA.
- [ ] `playwright-report` downloaded and reviewed — same authentication
      limitation.
- [ ] The four checks are configured as **required status checks** on `main`
      (see `docs/QUALITY-GATES.md`), so a red gate blocks the merge. Branch
      protection could not be read anonymously (401); confirm this in repository
      settings before relying on it to block a merge.

### Merge record

| | |
| --- | --- |
| Pull request | [#7](https://github.com/mdabbo/Namma-Finance/pull/7) — `main` ← `redesign/v0.7.0` |
| Merge commit | `177e2aa` — *Merge pull request #7 from mdabbo/redesign/v0.7.0* |
| Method | Merge commit (not squashed), preserving all 50 commit messages |
| Scope | 50 commits, 244 files |
| Gating evidence | `Quality gates` run 33389471727 on `d409a9c`, success, all four jobs |

- [x] `d409a9c` verified as an ancestor of `origin/main`.
- [ ] `Quality gates` green on the **post-merge** `main` commit `177e2aa`
      (run #24). The merge commit is a tree no pre-merge run tested, so this is
      the first gate against `main` as shipped. Confirm before treating `main`
      as a known-good base.

## Redesign acceptance

- [x] No more than six top-level navigation items; every previous route still
      reachable through redirects.
- [x] Arabic RTL and English LTR verified in the UI suite, not only by review.
- [x] Dashboard fits 1366×768 and shows four headline KPIs, not a KPI grid.
- [x] Project workspace reduced to six tabs; finance section reduced to one
      workspace with secondary navigation.
- [x] Settings presents one navigator, not two: a grouped sidebar whose
      membership and route authorization share a single source of truth.
- [x] Onboarding is skippable, resumable, and derives progress from real data.
- [x] Demo data is clearly marked and removable from a permanent location.

## Data safety

- [x] Schema identity is **27**: the baseline recreates 24 — verified
      object-for-object against the retired chain before the chain was deleted —
      and the forward migrations `0003`, `0004` and `0005` carry it to 25, 26
      and 27. `PRAGMA user_version`, `app_metadata.schema_version`,
      `CURRENT_SCHEMA_VERSION`, `release/release.json` and
      `docs/MIGRATION-NOTES.md` agree, and a test asserts they do.
- [x] The schema-27 audit-version migration writes no historical `audit_logs`
      row and does not weaken audit immutability; a schema-26 database holding
      finalized 0.6.x-stamped rows upgrades cleanly
      (`test/migrations.test.ts`, and `cargo test`).
- [x] Development databases that recorded migration 5 under the previous
      `0005` checksum must be recreated; documented in
      `docs/MIGRATION-NOTES.md`. Pre-rebase development databases are not
      upgradeable and must be reset.
- [x] Pre-rebase source and all 24 migration files preserved at
      `pre-db-rebase-v0.6.7` and `pre-ui-redesign-v0.6.0`, both pushed.
- [x] Old development databases fail loudly rather than being migrated, and
      pre-rebase backups are refused before any file is replaced.
- [x] The local development database was moved aside, not deleted.
- [ ] Complete a fresh two-PC sync acceptance test before production use.

## Distribution

- [x] Installer built locally from the release tree with
      `pnpm --filter @mep/desktop exec tauri build`.

  | | |
  | --- | --- |
  | Artifact | `NAMAA Finance_0.7.0_x64-setup.exe` (NSIS, x64) |
  | Bundle types produced | NSIS only — no MSI target is configured |
  | Signature | **NotSigned** |
  | Product version | 0.7.0 |

  The installer's size, SHA-256 and originating commit are recorded in the
  `release-evidence.txt` produced beside it by each build, rather than pinned
  here: a hash written into this file would describe the commit *before* the one
  that contains the hash. The authoritative pairing of installer to commit is
  the `desktop-build-evidence` artifact from CI.

- [x] Rebuilt from the final **pushed** commit by CI: the `Desktop production
      build` job succeeded on `da440cd` in both runs above and uploaded
      `desktop-installers` (4.75 MB) plus `desktop-build-evidence`. Those CI
      artifacts — not the local build — are the ones to distribute.
- [ ] Sign and verify the installer before any production distribution
      (`WINDOWS-CODE-SIGNING.md`). **The installer is unsigned; while unsigned it
      must stay labelled Beta and must not be presented as a trusted production
      release.**
- [ ] Confirm a clean-machine install starts, creates a fresh database, and
      completes onboarding.
- [ ] Obtain explicit approval before changing the Beta channel to Stable.

## Packaged-application verification

No automated test drives the packaged Tauri binary, so everything in this
section is a manual observation or is covered only at the source level. Items
marked *(source)* are asserted by the automated suites against the real schema
and migrations, not against the installed `.exe`.

- [x] *(source)* A fresh database reports schema 27 with an empty audit log.
- [x] *(source)* New audit rows are stamped `0.7.0`.
- [x] *(source)* The application lock fails closed on corrupt state (Rust suite).
- [x] *(source)* Demo workspace can be created and removed (Playwright suite).
- [x] *(source)* A complete client → project → contract → certificate → payment
      cycle works, asserted against the database (Playwright suite).
- [x] *(source)* Voiding a payment reopens the certificate.
- [x] *(source)* Assignment cancellation freezes earnings from stored evidence
      inside the Rust transaction.
- [x] *(source)* Saved finance views restore `projectId` scope.
- [ ] The same list re-confirmed by launching the installed application on a
      clean machine. **Not done.**

## Release status

**Beta.** Not production-ready. The installer is unsigned. Known limitations are
recorded in `KNOWN-LIMITATIONS.md`; the database reset requirement is in
`MIGRATION-NOTES.md` and the changelog.

**Status: MERGED, NOT SHIPPABLE.** PR #7 merged to `main` as `177e2aa` after
`Quality gates` passed all four required jobs on `d409a9c` across both the push
and pull-request runs, with none missing or skipped.

Merging is not shipping, and this build is not ready to distribute to anyone.
Outstanding before any distribution:

- **Sign the installer.** It is unsigned. While unsigned it must stay labelled
  **Beta** and must not be presented as a trusted production release.
- **Confirm a clean-machine install** starts, creates a fresh database at schema
  27, and completes onboarding. No automated test drives the packaged binary, so
  nothing has verified the installed application.
- **Complete the two-PC sync acceptance test.**
- **Confirm the four checks are required status checks on `main`**, so a future
  red gate actually blocks a merge. This was never verified — branch protection
  could not be read anonymously.
- **Confirm run #24 is green** on the post-merge merge commit.

Anyone pulling `main` must delete and recreate their development database; there
is no upgrade path from the retired migration chain. See `MIGRATION-NOTES.md`.
