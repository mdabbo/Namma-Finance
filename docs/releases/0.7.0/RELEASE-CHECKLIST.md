# NAMAA Finance 0.7.0 Beta release checklist

This checklist is the release evidence index for v0.7.0 Beta. It must describe
the exact source tree being released; local command output is local evidence
only, and GitHub Actions evidence must come from the workflow run for the exact
commit under review.

## Release identity

- [x] Application version: **0.7.0**.
- [x] Channel: **Beta**.
- [x] Schema version: **27**.
- [x] Root, desktop, mobile, core, Cargo, Tauri, generated release constants,
      Rust `CURRENT_SCHEMA_VERSION`, and `release/release.json` are checked by
      `pnpm version:check` and release regression tests.
- [x] Unsigned Windows installers remain labelled **Beta** and are not
      represented as trusted production releases.

## Documentation reconciled

- [x] Schema is documented as **27**, not 24.
- [x] Forward migrations `0003`, `0004`, and `0005` are documented after the
      baseline pair.
- [x] Pre-rebase development databases, and early v0.7.0 databases that recorded
      the old `0005` checksum, are documented as requiring reset.
- [x] Cancellation earnings are documented as derived by Rust inside
      `cancel_assignment_atomic`, in the same transaction that freezes them.
- [x] Local gate results are not presented as GitHub CI evidence.
- [x] No automated packaged-Tauri test is claimed. Packaged-app checks remain
      manual unless explicitly marked as source-level coverage.

## Local gate results

Run these commands exactly, in order, on the final source tree:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass - lockfile satisfied, no drift |
| `pnpm version:check` | pass - 0.7.0 (Beta), schema 27 |
| `pnpm lint` | pass - 0 errors, 2 `react-hooks/exhaustive-deps` warnings |
| `pnpm typecheck` | pass - 3/3 workspaces |
| `pnpm test` | pass - scripts 9, core 233, desktop 425 |
| `pnpm test:coverage` | pass - 96.88% statements / 90.53% branches / 96.05% functions |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` | pass |
| `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings` | pass |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | pass - 49 |
| `pnpm --filter @mep/desktop test:e2e` | pass - 148 passed, 2 expected viewport skips |
| `pnpm --filter @mep/desktop exec tauri build` | pass - NSIS installer produced |

## GitHub Actions evidence

Do not write that all tests pass until `Quality gates` is green for the exact
HEAD commit of the release pull request.

| Item | Evidence |
| --- | --- |
| Pull request | pending |
| Final commit SHA | pending |
| Workflow run URL | pending |
| TypeScript and unit tests | pending |
| Rust quality | pending |
| Playwright E2E | pending |
| Desktop production build | pending |
| Uploaded artifacts | pending |

The `Desktop production build` job uploads `desktop-installers` and
`desktop-build-evidence`. `desktop-build-evidence/release-evidence.txt` must name
the commit SHA, source ref, run URL, and run attempt for the same workflow run.

## Artifact verification

- [x] Current build contains a 0.7.0 NSIS `.exe` installer:
      `NAMAA Finance_0.7.0_x64-setup.exe`.
- [x] No MSI target is configured; NSIS is the only configured bundle target.
- [x] Older local installers for 0.3.0, 0.4.0, and 0.5.0 are present in the
      local bundle directory and must not be treated as current
      release output.
- [x] Local installer SHA-256:
      `4CC936FFD15DBBADA61FDD843304BB88BADE945AC1071CF5EC410D959B25C611`.
- [ ] CI `release-evidence.txt` names the exact commit SHA and run reference.
- [ ] Installer signature is verified. Until signed, status remains **Beta**.

## Packaged-application verification

No automated test in this repository drives the packaged Tauri binary. The
checks below are either source-level automated evidence or manual packaged-app
evidence, and the label must stay truthful.

- [x] *(source)* Fresh database reports schema 27 with an empty audit log.
- [x] *(source)* New audit rows are stamped `0.7.0`.
- [x] *(source)* App lock fails closed.
- [x] *(source)* Demo workspace can be created and removed.
- [x] *(source)* Complete client -> project -> contract -> certificate ->
      payment cycle works.
- [x] *(source)* Voiding payment reopens the certificate.
- [x] *(source)* Assignment cancellation freezes earnings from stored evidence
      inside the Rust transaction.
- [x] *(source)* Saved finance views restore `projectId` scope.
- [ ] *(manual packaged app)* Fresh installed application opens with a fresh
      database.
- [ ] *(manual packaged app)* Schema reports 27 in the installed application.
- [ ] *(manual packaged app)* Audit rows report 0.7.0.
- [ ] *(manual packaged app)* App lock fails closed.
- [ ] *(manual packaged app)* Demo workspace can be created and removed.
- [ ] *(manual packaged app)* Complete client -> project -> contract ->
      certificate -> payment cycle works.
- [ ] *(manual packaged app)* Voiding payment reopens the certificate.
- [ ] *(manual packaged app)* Assignment cancellation freezes earnings
      correctly.
- [ ] *(manual packaged app)* Saved finance views restore `projectId` scope.

## Branch protection

`main` currently reports required status checks as off/empty through the public
branch metadata. Treat green gates as release discipline, not repository
enforcement, until branch protection requires the four `Quality gates` jobs.

## Remaining limitations

- Windows installer is unsigned and must remain **Beta**.
- Clean-machine packaged install has not been manually verified.
- Fresh two-PC cloud sync acceptance has not been repeated on this build.
- Packaged `.exe` behaviour is not covered by automation.
- `main` does not enforce required status checks.

## Recommendation

**NOT READY** until the final release pull request's `Quality gates` run is
green for the exact HEAD, release artifacts are verified against that run's
`release-evidence.txt`, and the remaining manual packaged-app checks are either
completed or explicitly accepted as limitations.
