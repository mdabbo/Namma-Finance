# NAMAA Finance 0.6.0 release checklist

## Source and quality

- [ ] Work is on `hardening/v0.6.0`, not `main`.
- [ ] `pnpm version:check` passes.
- [ ] Desktop, mobile/Expo, Cargo, Tauri, and installer versions all report 0.6.0.
- [ ] Frozen install, type checking, all TypeScript/Rust tests, coverage, rustfmt, Clippy, and desktop build pass.
- [ ] GitHub Windows quality workflow passes and its coverage artifact is retained.
- [ ] No open P0 data-integrity or security issue remains.
- [ ] Migration upgrade tests preserve populated legacy financial data.

## Data safety

- [ ] Create and validate a manual backup from a representative database.
- [ ] Restore that backup on a disposable test installation.
- [ ] Verify `PRAGMA integrity_check`, foreign keys, and schema version 23.
- [ ] Confirm rollback instructions and preserve the pre-upgrade safety backup.

## Windows installer

- [ ] Build the NSIS installer from a clean checkout.
- [ ] Digitally sign the executable and installer using the documented process.
- [ ] Verify the signature and SHA-256 checksum on another Windows PC.
- [ ] Test fresh install, upgrade, launch, uninstall, and retained user data.
- [ ] Confirm Settings displays version 0.6.0, Beta, and schema 23.
- [ ] If an internal 0.6.7 development installer was ever distributed, test and document the downgrade path before installing 0.6.0 over it.

## Release approval

- [ ] Review known limitations.
- [ ] Attach test summary, migration notes, rollback notes, installer checksum, and release notes.
- [ ] Obtain explicit release approval before changing the channel to Stable.
