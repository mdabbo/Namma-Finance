# NAMAA Finance 0.7.0 Beta release checklist

Milestone numbering below follows the redesign brief as delivered. The brief's
own headings are numbered 0–9; where a reader counts the UX audit as milestone
1, add one to each number.

## Source and quality

- [x] Work remains on `redesign/v0.7.0`; nothing is merged to `main`.
- [x] Application, mobile, core, Cargo, Tauri, and release-manifest versions are
      synchronized at 0.7.0 (`version:check` verified).
- [x] Type checking, TypeScript tests, Rust tests, and the Playwright UI suite
      pass locally on the final source tree — figures in `TEST-SUMMARY.md`.
      A local run is not release evidence; the CI block below is.
- [x] Every redesign milestone was followed by an independent audit pass, and
      each confirmed defect was fixed with regression coverage before the next
      milestone began.

### CI evidence (required before release)

A local pass proves nothing to anyone who was not sitting at that machine, so
the release may not claim green gates until this block is filled in from a real
GitHub Actions run on the released commit.

- [ ] `Quality gates` workflow green on the released commit — all four jobs
      (`TypeScript and unit tests`, `Rust quality`, `Playwright E2E`,
      `Desktop production build`).
- [ ] Commit SHA: `__________________________________________`
- [ ] Workflow run URL: `__________________________________________`
- [ ] `desktop-build-evidence` artifact downloaded; `release-evidence.txt`
      inside it names the same commit SHA as above.
- [ ] `playwright-report` artifact downloaded and reviewed.
- [ ] The four checks are configured as required status checks on `main`
      (see `docs/QUALITY-GATES.md`), so a red gate blocks the merge.

## Redesign acceptance

- [x] No more than six top-level navigation items; every previous route still
      reachable through redirects.
- [x] Arabic RTL and English LTR verified in the UI suite, not only by review.
- [x] Dashboard fits 1366×768 and shows four headline KPIs, not a KPI grid.
- [x] Project workspace reduced to six tabs; finance section reduced to one
      workspace with secondary navigation.
- [x] Onboarding is skippable, resumable, and derives progress from real data.
- [x] Demo data is clearly marked and removable from a permanent location.

## Data safety

- [x] Schema identity is **27**: the baseline recreates 24 — verified
      object-for-object against the retired chain before the chain was deleted —
      and the forward migrations carry it to 25, 26 and 27. `PRAGMA
      user_version`, `app_metadata.schema_version`, `CURRENT_SCHEMA_VERSION`
      and `docs/MIGRATION-NOTES.md` agree.
- [x] The schema-27 audit-version migration writes no historical `audit_logs`
      row and does not weaken audit immutability; a schema-26 database holding
      finalized 0.6.x-stamped rows upgrades cleanly
      (`test/migrations.test.ts`).
- [x] Development databases that recorded migration 5 under the previous
      `0005` checksum must be recreated; documented in
      `docs/MIGRATION-NOTES.md`.
- [x] Pre-rebase source and all 24 migration files preserved at
      `pre-db-rebase-v0.6.7` and `pre-ui-redesign-v0.6.0`, both pushed.
- [x] Old development databases fail loudly rather than being migrated, and
      pre-rebase backups are refused before any file is replaced.
- [x] The local development database was moved aside, not deleted.
- [ ] Complete a fresh two-PC sync acceptance test before production use.

## Distribution

- [x] Installer built locally from the release tree.

  | | |
  | --- | --- |
  | Artifact | `NAMAA Finance_0.7.0_x64-setup.exe` (NSIS, x64) |
  | Size | 4.63 MB |
  | SHA-256 | `D7590A4AD4461756AFECCCA3C4F38A1249FB7DDC3CDD892EAF1BB1F1D63CD806` |
  | Signature | **NotSigned** |
  | Product version | 0.7.0 |

- [ ] Rebuild from the final **pushed** commit and re-record the checksum above;
      the hash recorded here is from the local release tree.
- [ ] Sign and verify the installer before any production distribution
      (`WINDOWS-CODE-SIGNING.md`).
- [ ] Confirm a clean-machine install starts, creates a fresh database, and
      completes onboarding.
- [ ] Obtain explicit approval before changing the Beta channel to Stable.

## Release status

**Beta.** Not production-ready. Known limitations are recorded in
`KNOWN-LIMITATIONS.md`; the database reset requirement is in
`MIGRATION-NOTES.md` and the changelog.
