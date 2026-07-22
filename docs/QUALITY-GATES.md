# NAMAA Finance quality gates

Every pull request and push to `main` or `hardening/**` runs the Windows quality workflow.

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
8. Production desktop TypeScript/Vite build.

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
pnpm --filter @mep/desktop build
```

The deterministic financial property suite uses fixed seeds so a failure is reproducible. It covers allocation conservation, signed rounding, basis-point boundaries, 500-certificate contract reconciliation, and 2,000-row EGP/USD/SAR rollups. Increasing iterations or adding seeds is encouraged; changing a seed to hide a failure is not.

Migration tests apply the real forward-only SQL chain to populated legacy databases and verify retained financial records, SQLite integrity, foreign keys, and the final schema version.
