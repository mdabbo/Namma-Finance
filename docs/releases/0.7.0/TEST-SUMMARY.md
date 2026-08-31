# Test summary — 0.7.0 Beta

The figures below are **local** measurements taken on Windows with
`pnpm install --frozen-lockfile`, `pnpm version:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:coverage`,
`cargo fmt/clippy/test --manifest-path apps/desktop/src-tauri/Cargo.toml`, and
`pnpm --filter @mep/desktop test:e2e`.

> **A local run is not release evidence.** The authoritative record is the
> `Quality gates` GitHub Actions run on the released commit; record its URL and
> SHA in the CI evidence block of `RELEASE-CHECKLIST.md`, and do not claim
> passing gates in release notes until that run is green. Each run uploads the
> coverage report, the Playwright HTML report, traces, and a
> `release-evidence.txt` naming the exact commit. Nothing in this file may be
> cited as proof that CI passed — at the time of writing, the CI block in
> `RELEASE-CHECKLIST.md` is still empty.

Measured on the final Milestone 6 tree of `redesign/v0.7.0` — the commit
carrying `docs(release): finalize v0.7.0 beta evidence`.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | lockfile satisfied, no drift |
| Release metadata | `version:check` verifies **0.7.0 (Beta), schema 27** |
| Lint | **0 errors**, 2 warnings (both pre-existing `react-hooks/exhaustive-deps`) |
| Type checking | 3/3 workspaces pass (`core`, `desktop`, `mobile`) |
| Release script tests | **9 passed**, 0 failed |
| `@mep/core` unit tests | **233 passed**, 0 failed (18 files) |
| `@mep/desktop` tests | **425 passed**, 0 failed (38 files) |
| Core financial coverage | **96.88%** statements / 90.53% branches / 96.05% functions |
| `cargo fmt --check` | clean |
| `cargo clippy --all-targets -- -D warnings` | clean |
| Rust tests | **49 passed**, 0 failed |
| Playwright UI tests | **148 passed**, 0 failed, 2 skipped (3 viewports) |

The two skipped Playwright tests are viewport-scoped visual baselines that run
only on the viewport they were captured for.

These counts move with every milestone; treat a mismatch against the current
tree as a stale document, not as a regression. The figures above replace the
`b36f571` measurements this file previously carried, which predated milestones
1–6 and understated every suite.

## What the financial tests cover

- **Property and fuzz**: 30 randomised workspaces hold every accounting
  identity; a 60-project workspace stays exact at scale.
- **Payment integrity**: allocation capacity, cross-contract rejection,
  reopening on certificate increase, and no hiding of allocated cash.
- **Certificate lifecycle atomicity**: create, edit, transition and void are
  Rust-owned transactions; a rejected edit leaves neither a partial write nor an
  audit row. A certificate cannot be bound to another contract's approved
  revision, and an archived contract or project is read-only.
- **Assignment lifecycle**: the cancelled-assignment earned figure is derived
  from stored evidence **inside the Rust transaction** that freezes it, and both
  engines are held to `fixtures/team-payout.json`.
- **Release metadata**: the manifest, all four package versions, Tauri, Cargo,
  the generated constants, the Rust schema constant and the newest migration's
  `PRAGMA user_version` are asserted to agree, independently of the script that
  writes them.
- **Lifecycle and atomicity**: archive/void semantics, transaction rollback on
  failed reconciliation, and unique-code enforcement under concurrency.
- **Concurrency simulation**: 10 projects × 20 people, including a reconcile
  storm racing the background sweep.
- **Sync**: two-device round trips with FK translation, conflict resolution,
  and keyset cursor tie-breaks.
- **Baseline acceptance**: a freshly created database carries the complete
  schema, seeded reference data, an empty audit log, per-install sync identity,
  and every financial integrity constraint (duplicate allocation, approved
  revision immutability, append-only audit, date validation, document hashes).

## What the UI suite covers

The full client → project → contract → certificate → payment cycle, asserting
against the **database** as well as the screen; expenses, team members, and time
entries; six-section navigation with breadcrumbs and active state; the grouped
Settings navigation with one landmark and every section URL addressable;
project scope in the finance saved views (`projectId`, including corrupt and
legacy values); English/Arabic direction and light/dark switching; onboarding
skip, resume, and demo load/removal; and visual regression states at three
viewport sizes.

## Not covered by automation

- Application-lock password verification (Argon2, attempt throttling) is
  exercised by the Rust suite rather than the UI suite, because the browser
  bridge deliberately refuses those calls.
- **No automated test drives the packaged Tauri binary.** The installer is
  verified by inspection and manual launch only; nothing in this repository
  asserts the behaviour of the built `.exe`. Any claim about the packaged
  application is a manual observation, not a test result.

See `KNOWN-LIMITATIONS.md`.
