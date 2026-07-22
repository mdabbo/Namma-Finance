# Test summary - 0.6.7

The local release gate covers financial-core unit and property tests, SQLite migrations, transaction atomicity, audit trails, backups, lifecycle rules, numbering, contract revisions, payment integrity, two-device synchronization, reports, app-lock error handling, TypeScript type checking, release metadata, Rust tests, Clippy with warnings denied, and the desktop production build.

Final local validation on 2026-07-22 passed with 137 core tests, 132 desktop tests, and 14 Rust tests. The desktop tests include 15 two-device sync scenarios and the lock regression tests added for this hardening update. Workspace type checking, release-version verification, Clippy with warnings denied, and the desktop production build also passed. The build retained the documented non-blocking large-chunk warning.

GitHub Actions remains the authoritative clean-checkout evidence after the branch is pushed. Code signing, installer verification, and a fresh two-PC acceptance sync remain separate release-approval gates.
