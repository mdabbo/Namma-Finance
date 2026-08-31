# UI testing (Milestone 8)

## Running

```bash
cd apps/desktop
pnpm test:e2e                 # full suite, three viewports
pnpm test:e2e --project=desktop-1440
pnpm test:e2e:update          # refresh visual baselines after an intended redesign
```

Both servers start automatically. Nothing needs to be running first.

## Why a browser, and how the data is real

The app ships inside a Tauri WebView2 window and its data layer lives in Rust,
so a browser has neither the SQL plugin nor the app-lock commands. Two
capabilities are therefore bridged, **only** when Vite runs in `e2e` mode:

| Module | Bridge | What it does |
| --- | --- | --- |
| `src/lib/db.ts` | `src/lib/db.e2e.ts` → `e2e/db-server.mjs` | Forwards SQL to a real SQLite instance running the **real** `0001_baseline.sql` + `0002_seed_reference_data.sql` |
| `src/lib/lock.ts` | `src/lib/lock.e2e.ts` | Answers the lock-state question from the same `settings` rows the Rust code reads |

Everything else — React, routing, i18n, the repositories, `@mep/core` money
maths, numbering sequences, audit and validation triggers — is the shipped
code. Specs assert against the **database** as well as the screen, because a
green screen with no row written would be a false pass.

The swap is a Vite plugin that only loads for `--mode e2e`, so a production
build cannot reach either bridge.

Tests run in **Microsoft Edge**, the same engine family as the WebView2 runtime
the desktop app uses, rather than bundled Chromium.

### What the bridges deliberately do not cover

Password verification stays in Rust (Argon2, attempt throttling, corrupt-state
handling) and is covered by `cargo test` and `test/lock.test.ts`. A stubbed
browser implementation would prove nothing, so `lock.e2e.ts` refuses those
calls outright.

## Coverage

One worker, no parallelism: every spec shares one database, exactly as the
desktop app owns one file. Each spec starts from a freshly migrated database.

| Spec | Covers |
| --- | --- |
| `smoke` | App boots against the bridge with no page errors |
| `navigation` | Six top-level sections, active state, breadcrumbs, secondary navigation, command palette, English/Arabic direction, light/dark |
| `workflows` | Client → project → contract → certificate → payment (money verified in the ledger), expense, team member, time entry |
| `onboarding` | Six-step setup, skip/resume persistence, demo workspace load and removal |
| `visual` | The eight required screenshots |

## Visual baselines

Baselines live in `e2e/specs/visual.spec.ts-snapshots/`, one set per viewport
(1366×768, 1440×900, 1920×1080), so a layout that only breaks on the smallest
screen is caught. They are committed.

Captured states: empty dashboard, populated dashboard, projects page, project
workspace, finance workspace, payment form, Arabic RTL dashboard, dark mode.

Tolerance is `maxDiffPixelRatio: 0.02` with animations disabled — enough to
absorb font hinting and GPU compositing differences between machines while
still catching layout and colour regressions. Baselines are platform-tagged
(`-win32`); regenerate on the platform you test on.

## Populated states use the demo workspace

Rather than hand-built fixtures, the populated screenshots load the Milestone 6
demo workspace, so they show realistic multi-currency data — a paid
certificate, an overdue one, an upcoming collection, project and overhead
expenses, an assigned engineer with logged time.
