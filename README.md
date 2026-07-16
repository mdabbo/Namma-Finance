# NAMAA Finance

Project Financial Management System for an MEP engineering design office
(HVAC · Plumbing · Fire Fighting · Electrical · BIM). Bilingual (العربية/English),
RTL/LTR, offline-first Windows desktop app.

## Monorepo layout

| Package | What it is |
|---|---|
| `packages/core` | UI-free TypeScript: domain models, **all financial calculations**, validation (zod), AR/EN dictionaries. Shared by desktop, mobile (Phase 4) and future web. |
| `apps/desktop` | Tauri v2 + React 19 + Vite + Tailwind v4. SQLite (WAL) in the app data directory with numbered migrations. |

## Financial invariants (do not break)

- **All money is stored as integers** in the smallest currency unit (`*_minor`: piasters/cents/fils). No floats, ever.
- Rates are integer **basis points** (`*_bp`, 14% = 1400). FX rates are integer micro-units (EGP per major unit × 1e6).
- Multiplication/division goes through BigInt (`mulDivRound`) with half-up rounding.
- **Derived figures are never stored** — VAT, retention, advance recovery, net payable, balances and profit are always recomputed from source records by `packages/core/src/calc`.

### Confirmed business rules

1. Certificate discount applies **before everything** (VAT/retention/advance computed on the discounted gross).
2. VAT (default 14%) is computed **on the discounted gross**; retention/advance/withholding are computed on the same pre-VAT base.
3. Retention is withheld **per certificate** and released at project end (payment kind `RETENTION_RELEASE`).
4. Advance payment is recovered **proportionally** from each certificate (`base × advance ÷ contract value`), capped at the un-recovered remainder; a `MANUAL` per-certificate mode also exists.
5. A certificate is **overdue** when it is billable, unpaid, and past `submission date + contract payment terms` (or its manual due-date override).
6. Performance bond is **tracking only** — it never affects calculations.
7. Project codes: `PRJ-YYYY-NNN` (prefix configurable in Settings, sequence resets yearly).

## Development

```powershell
pnpm install
pnpm test                       # run the financial test suite (@mep/core, vitest)
pnpm --filter @mep/desktop tauri dev    # run the desktop app
pnpm --filter @mep/desktop tauri build  # build the Windows installer (NSIS)
```

Requirements: Node ≥ 20, pnpm, Rust (MSVC), VS Build Tools C++ workload.

- The SQLite DB lives at `%APPDATA%\com.mepfinance.app\mep-finance.db`.
- Migrations: `apps/desktop/src-tauri/migrations/*.sql`, registered in `src-tauri/src/lib.rs`.
- A local auto-backup runs once per day on app start into `%APPDATA%\com.mepfinance.app\backups\`.

## Phase plan

1. **Phase 1 (this)** — core engine + full desktop app + installer.
2. Phase 2 — project stages, cash-flow forecast, profitability, documents, reports center, Excel import.
3. Phase 3 — sync backend (Fastify+PostgreSQL or Supabase) + auth + audit log.
4. Phase 4 — Expo mobile companion app.
5. Phase 5 — roles/permissions, notifications, Gantt, custom dashboards.
