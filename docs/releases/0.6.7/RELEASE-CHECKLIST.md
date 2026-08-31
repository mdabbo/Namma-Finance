# NAMAA Finance 0.6.7 Beta release checklist

## Source and quality

- [x] Work remains on `hardening/v0.6.0`; nothing is merged to `main`.
- [x] Application, mobile, core, Cargo, Tauri, and release-manifest versions are synchronized at 0.6.7.
- [x] Local TypeScript tests, type checking, Rust tests, Clippy, and the desktop production build pass on the final source tree.
- [x] Schema 23 migration and financial regression tests pass.
- [ ] GitHub Windows quality workflow passes on the pushed commit.

## Data and sync safety

- [x] App-lock operations and sync mutations share the managed serialized SQLite pool.
- [x] Sync mutation and audit-source changes commit or roll back atomically.
- [x] Supabase schema preflight and forward-only repair scripts are documented.
- [x] Test cloud and local databases were reset only after explicit confirmation that all existing records were disposable.
- [ ] Complete a fresh two-PC sync acceptance test before production use.

## Distribution

- [ ] Build the NSIS installer from the final pushed commit.
- [ ] Sign and verify the installer before any production distribution.
- [ ] Record the final installer SHA-256 checksum.
- [ ] Obtain explicit approval before changing the Beta channel to Stable.
