# Sync Integrity Final Audit

Current as of v0.7.1 Beta, schema 28.

This audit covers the v0.7.1 sync-integrity hardening milestones. Its purpose is
to verify that synchronized financial mutations follow the same domain rules as
local writes, and that invalid remote rows become reviewable evidence rather
than silent overwrites.

## Static Audit

Protected synchronized tables are declared in
`apps/desktop/src/lib/sync/registry.ts`:

- `contracts`
- `contract_revisions`
- `payment_certificates`
- `payments`
- `payment_certificate_allocations`
- `project_assignments`
- `expenses`
- `person_payments`

The pull path in `apps/desktop/src/lib/sync/engine.ts` routes protected
financial tables through domain-aware repository functions before local mutation:

- `applySyncedCertificate`
- `applySyncedPayment`
- `applySyncedAllocation`
- `applySyncedAssignment`
- `applySyncedPersonPayment`
- `applySyncedExpense`
- `applySyncedContractRevision`
- `applySyncedVariationOrder`

The remaining generic mutation path is reached only after those protected table
branches have continued. Simple/master data tables still use generic sync
mutation with registry allowlisting, foreign-key translation, and conflict
handling.

## Findings

No confirmed remaining sync bypass was found for:

- certificate lifecycle validation,
- direct remote `PAID` status acceptance,
- financial mutation through generic SQL after protected routing,
- cross-contract allocation,
- resurrected void records,
- mutated approved revisions,
- changed cancellation evidence,
- person-payment overpayment,
- partial transaction application,
- rejected conflict loss,
- local-vs-sync calculation drift.

One stale root limitation document still described the pre-hardening certificate
sync gap. It has been updated to describe the current v0.7.1 limitation:
older peers may not advertise protocol metadata unless the optional
`sync_peers` table is installed, while protected financial pulls still fail
closed through Rust validation.

## Test Evidence

Existing and added tests cover:

- sync table risk mapping equals the Rust mutation allowlist,
- synced certificate `PAID` status is derived from payment evidence,
- immutable submitted/approved/paid certificate financial fields are rejected,
- payment allocation settlement and reopening,
- payment amount and certificate capacity limits,
- cross-contract allocation rejection,
- archived contract payment rejection,
- cancellation earned evidence derivation and immutability,
- person-payment due caps and linked expense creation,
- standalone expense voiding and linked expense rejection,
- approved revision and variation-order immutability,
- rejected remote conflicts failing closed on `KEEP_REMOTE`,
- duplicate allocation handling without duplicated money,
- deterministic two-device acceptance scenarios,
- manual two-PC Supabase acceptance procedure.

The manual real-Supabase checklist is
`docs/TWO-PC-SYNC-ACCEPTANCE.md`.

## Remaining Limitations

- Real two-PC Supabase acceptance still requires a human operator with a
  disposable Supabase project; production credentials are not automated.
- `sync_peers` is optional for existing Supabase projects. Without it, old peers
  are not proactively identified before sync, but unsafe financial rows remain
  blocked by local Rust validation.
- Role enforcement remains client-side; Supabase per-role row-level security is
  not implemented.
- The local app lock does not encrypt the SQLite database.
- The mobile companion remains read-only and has no standalone APK.

## Merge Recommendation

READY, provided the complete local gate and exact-head GitHub Actions run pass.
