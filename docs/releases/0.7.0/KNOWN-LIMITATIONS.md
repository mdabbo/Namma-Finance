# Known limitations — 0.7.0 Beta

This build is **Beta**. It is not represented as production-ready.

## Data

- Development databases created before this release must be deleted and
  recreated; there is no upgrade path and none was attempted. Backups taken
  before this release restore only into a `pre-db-rebase-v0.6.7` build.
- The demo workspace creates real records. While loaded it contributes to every
  financial total, exactly as the sample data it is. Remove it from Settings
  before using a workspace for real work.
- The demo workspace can still be loaded into a workspace that already has
  clients or projects but no financial activity yet, so demo and real projects
  can coexist. Demo records are clearly marked and removal converges, but they
  are not otherwise segregated.

## Interface

- Wide create/edit forms (payment, certificate, contract, project) remain modal
  dialogs rather than side drawers. No flow stacks dialogs, and the four-column
  financial layouts need the overlay width.
- "Customize KPIs" on the dashboard is present but disabled; it is reserved for
  a future release.
- The redesign targets desktop widths. Layouts are verified at 1366×768,
  1440×900, and 1920×1080; narrower windows are not a supported target.

## Testing

- Visual regression baselines are platform-tagged (`-win32`) and were generated
  on Windows. A Linux CI runner will not match them; generate baselines on the
  platform under test or scope the visual project to Windows runners.
- The end-to-end suite drives the app in Microsoft Edge with the database and
  app-lock modules bridged, because a browser cannot reach Tauri's Rust layer.
  Application-lock password verification (Argon2, attempt throttling) is
  therefore covered by the Rust suite and unit tests, not by the UI suite.
- No automated test drives the packaged Tauri binary itself.

## Operations

- The Windows installer produced by this release is unsigned unless signed as a
  separate, deliberate step. Unsigned builds must stay labelled Beta and must
  not be presented as trusted production releases.
- A fresh two-PC cloud sync acceptance test has not been repeated against this
  build.
- The repository pins `pnpm@10.0.0` in `packageManager`, which may not match the
  pnpm that installs `node_modules` on a given machine; a store-version mismatch
  makes `pnpm add` fail until `pnpm install` is re-run.
