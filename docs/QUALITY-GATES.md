# NAMAA Finance quality gates

Every pull request, and every push to `main`, `redesign/**` or `hardening/**`,
runs the Windows quality workflow (`.github/workflows/quality.yml`).

## Workflow jobs

The workflow is split so a failure names the thing that broke:

| Job | Covers |
| --- | --- |
| `unit` | Frozen install, `version:check`, type checking, Vitest suites, core coverage. |
| `rust` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`. |
| `e2e` | The Playwright UI suite in Microsoft Edge, at three viewports. |
| `build` | Production desktop build. Runs only after `unit`, `rust` and `e2e` pass. |

`unit`, `rust` and `e2e` run in parallel; `build` depends on all three, so a
shippable artifact is never produced from a tree that failed a gate.

## Required gates

1. Frozen dependency installation.
2. TypeScript type checking for all workspace applications and packages.
3. Complete Vitest unit and integration suites.
4. Core financial coverage with minimum global thresholds:
   - statements: 90%
   - lines: 90%
   - functions: 90%
   - branches: 85%
5. Rust formatting (`cargo fmt --check`).
6. Rust linting with warnings denied (`cargo clippy --all-targets -- -D warnings`).
7. Rust tests.
8. Playwright UI suite (English LTR and Arabic RTL, light and dark, three viewports).
9. Production desktop TypeScript/Vite build.

## Branch protection — recommended required checks

Configure these as **required status checks** on `main` (Settings → Branches →
Branch protection rules), so a red gate blocks the merge button rather than
relying on a reviewer noticing:

- `TypeScript and unit tests`
- `Rust quality`
- `Playwright E2E`
- `Desktop production build`

Also enable *Require branches to be up to date before merging*, so the gates
run against the actual post-merge tree. Until these are marked required, a
failing UI suite does **not** technically block a merge — the workflow reports
red but GitHub still permits the merge.

## Downloadable evidence

Every run uploads artifacts, on success and on failure alike:

| Artifact | Contents |
| --- | --- |
| `core-financial-coverage` | Text, JSON summary, and LCOV coverage output. |
| `playwright-report` | The HTML report for the UI suite. |
| `playwright-traces-and-screenshots` | Traces and failure screenshots (empty when everything passes). |
| `desktop-build-evidence` | Build log plus `release-evidence.txt` — the commit SHA, ref, and run URL. |

`release-evidence.txt` exists so release documentation can cite the exact
commit a green run was measured on, rather than an unattributed claim.

The coverage artifact includes text, JSON summary, and LCOV output. Coverage applies to `packages/core/src/money` and `packages/core/src/calc`, excluding barrel-only index files.

## Local verification

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:coverage
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @mep/desktop test:e2e
pnpm --filter @mep/desktop build
```

The UI suite needs Microsoft Edge; CI relies on the copy preinstalled on the
GitHub `windows-latest` image. A green local run is not release evidence on its
own — see the CI evidence block in the release checklist.

### Visual baselines are machine-sensitive

Screenshot baselines are recorded on a developer machine and replayed on the CI
runner, which does not have identical fonts. Text baselines can shift a few
pixels while every box stays put; on a text-dense page that alone exceeded the
2% global diff budget on the first CI run. Tolerances therefore absorb glyph
rendering and police layout — a collapsed column or a missing section moves far
more than any font difference.

When a screenshot check fails, download the `playwright-traces-and-screenshots`
artifact and compare `-actual` against `-expected` **before** touching a
threshold. If the boxes moved it is a real regression; if only text shifted it
is font rendering. Raising a tolerance to silence a genuine layout change is
never acceptable.

The deterministic financial property suite uses fixed seeds so a failure is reproducible. It covers allocation conservation, signed rounding, basis-point boundaries, 500-certificate contract reconciliation, and 2,000-row EGP/USD/SAR rollups. Increasing iterations or adding seeds is encouraged; changing a seed to hide a failure is not.

Migration tests apply the real forward-only SQL chain to populated legacy databases and verify retained financial records, SQLite integrity, foreign keys, and the final schema version.
