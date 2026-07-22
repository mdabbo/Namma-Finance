# Test summary — 0.6.0

Required release gates:

- Frozen pnpm installation
- Release metadata consistency check
- TypeScript type checking
- Core unit/property tests
- Desktop SQLite integration, migration, audit, sync, backup, and transaction tests
- Financial-core coverage thresholds
- Rust formatting and Clippy with warnings denied
- Rust tests
- Desktop production build

Financial-core minimum coverage is 90% statements, 90% lines, 90% functions, and 85% branches. The final command results for this implementation are recorded in the Milestone 16 delivery report; GitHub Actions is the authoritative clean-run evidence before release approval.

Expected Milestone 16 audit totals are 137 core tests, 130 desktop tests, and 12 Rust tests. These figures are evidence only when the complete frozen-install-to-production-build sequence passes on the final source tree.
