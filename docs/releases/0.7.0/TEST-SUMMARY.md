# Test summary — 0.7.0 Beta

All figures below were measured on the release commit, on Windows, with
`pnpm typecheck`, `pnpm test`, `cargo test`, and `pnpm test:e2e`.

| Gate | Result |
| --- | --- |
| Type checking | 3/3 workspaces pass (`core`, `desktop`, `mobile`) |
| Release metadata | `version:check` verifies 0.7.0 (Beta), schema 24 |
| `@mep/core` unit tests | **144 passed**, 0 failed (14 files) |
| `@mep/desktop` tests | **205 passed**, 0 failed (26 files) |
| Release script tests | **2 passed**, 0 failed |
| Rust tests | **15 passed**, 0 failed |
| Playwright UI tests | **66 passed**, 0 failed (3 viewports) |

## What the financial tests cover

- **Property and fuzz**: 30 randomised workspaces hold every accounting
  identity; a 60-project workspace stays exact at scale.
- **Payment integrity**: allocation capacity, cross-contract rejection,
  reopening on certificate increase, and no hiding of allocated cash.
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
entries; six-section navigation with breadcrumbs and active state; English/
Arabic direction and light/dark switching; onboarding skip, resume, and demo
load/removal; and eight visual regression states at three viewport sizes.

## Not covered by automation

Application-lock password verification (Argon2, attempt throttling) is exercised
by the Rust suite rather than the UI suite, because the browser bridge
deliberately refuses those calls. No automated test drives the packaged Tauri
binary. See `KNOWN-LIMITATIONS.md`.
