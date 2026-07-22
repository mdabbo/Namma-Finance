# Changelog

All notable changes to NAMAA Finance are documented here. Versions follow Semantic Versioning.

## [0.6.7] - 2026-07-20

### Verified

- Independent audit of the hardening branch: migration path 7 → 23 dry-run against a copy of real data (integrity/FK intact, data preserved), and runtime confirmation that sqlx applies all 23 migrations under the production stack and the app launches without freezing.
- Immutability triggers confirmed at runtime: physical DELETE of protected records is blocked; archive/void updates succeed.

### Notes

- Same feature set and schema (23) as the 0.6.0 hardening line; version relabelled to distinguish the audited, installer-packaged build from earlier development builds.

## [0.6.0] - 2026-07-22

### Added

- Transactional financial mutation boundaries and explicit payment-allocation integrity.
- Contract revisions and immutable historical commercial-term snapshots.
- Separate cash, accrual, committed, and forecast financial definitions.
- Immutable audit history, hardened backup/restore, application security controls, managed documents, sync-conflict review, and transactional numbering.
- Deterministic financial property tests, coverage thresholds, and Windows CI quality gates.
- A single release manifest, release-channel indicator, and visible application/schema versions.

### Security

- Restrictive Tauri CSP and filesystem capabilities.
- Argon2id application lock with retry throttling and fail-closed corrupt-state handling.
- Backup integrity, checksum, schema, and foreign-key validation.

### Release status

This build is a **Beta** release. It is not represented as production-ready; release approval requires the checklist and all P0 data-integrity gates to pass.
