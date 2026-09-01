# Two-PC Sync Acceptance Checklist

Current as of v0.7.1 Beta, schema 28.

This checklist is a manual acceptance procedure for a real Supabase workspace.
Do not use production customer data. Use two clean Windows PCs, or two isolated
Windows user profiles, running the same NAMAA Finance build.

## Scope

Use this procedure to prove that two desktop clients can exchange business data
through Supabase without bypassing the local financial domain model.

Do not automate production Supabase credentials. The operator should paste the
Supabase URL, anon key, and office login into each app instance manually.

## Setup

### Supabase

1. Create a disposable Supabase project, or confirm that the selected project
   contains no production financial records.
2. Apply `docs/supabase-schema.sql`.
3. For an upgraded workspace, apply the forward-only SQL files listed in
   `docs/PHASE3-SETUP.md`, including `docs/supabase-0018-sync-peers.sql` when
   testing v0.7.1 protocol advertisement.
4. Run `docs/supabase-cloud-preflight.sql` and save the result with the test
   evidence.
5. Create one office login under Supabase Authentication -> Users.
6. Disable public sign-up for the test project.
7. Record the Supabase project URL, but do not record the anon key or password
   in the release evidence.

### PC A

1. Install a clean v0.7.x Beta build.
2. Start NAMAA Finance with a fresh local database.
3. Confirm Settings -> About reports:
   - Application version: `0.7.1`
   - Channel: `Beta`
   - Schema version: `28`
4. Configure Settings -> Cloud sync with the test Supabase URL and anon key.
5. Sign in with the office login.
6. Press Sync now once and confirm it completes.

### PC B

1. Install the same v0.7.x Beta build used on PC A.
2. Start NAMAA Finance with a fresh local database.
3. Confirm Settings -> About reports the same application version, channel, and
   schema version as PC A.
4. Configure the same Supabase URL, anon key, and office login.
5. Press Sync now once and confirm it completes.

## Test Flow

### A to B

On PC A:

1. Create client `SYNC-A-CLIENT`.
2. Create project `SYNC-A-PROJECT` for that client.
3. Create contract `SYNC-A-CONTRACT` for `100,000.00 EGP`.
4. Create certificate `SYNC-A-PC-001` for `40,000.00 EGP`.
5. Submit and approve the certificate.
6. Create payment `SYNC-A-PAY-001` for `40,000.00 EGP` allocated fully to the
   certificate.
7. Press Sync now.

On PC B:

1. Press Sync now.
2. Verify the client, project, contract, certificate, and payment appear.
3. Verify exact values:
   - Contract value: `100,000.00 EGP`
   - Certificate gross: `40,000.00 EGP`
   - Payment amount: `40,000.00 EGP`
   - Certificate status: `PAID`
   - Certified revenue and cash-in totals include the certificate and payment.

### B to A

On PC B:

1. Void payment `SYNC-A-PAY-001` with reason `two-PC acceptance void`.
2. Confirm the certificate reopens to `APPROVED`.
3. Press Sync now.

On PC A:

1. Press Sync now.
2. Verify payment `SYNC-A-PAY-001` is voided.
3. Verify certificate `SYNC-A-PC-001` is `APPROVED`, not `PAID`.
4. Verify cash-in and outstanding totals reflect the voided payment.

## Offline Conflict Test

1. Disconnect PC B from the network.
2. On PC A, change project manager to `Manager A` and press Sync now.
3. On PC B, change the same project manager to `Manager B` while still offline.
4. Reconnect PC B.
5. Press Sync now on PC B, then on PC A.
6. Verify the conflict or last-writer workflow behaves deterministically for
   the metadata edit.
7. Record which value wins and the audit/conflict evidence shown by the app.

## Financial Conflict Test

Use a disposable test workspace only.

1. On PC A, create and approve certificate `SYNC-CONFLICT-PC-001`.
2. Press Sync now on PC A, then on PC B.
3. On a stale or deliberately older test client, attempt to change a financial
   field of the approved certificate, such as gross amount.
4. Press Sync now on the stale client.
5. Press Sync now on the current v0.7.1 client.
6. Verify the current client rejects the incoming financial mutation or surfaces
   it as a conflict.
7. Verify the certificate amount remains unchanged.
8. Verify a stale remote `PAID` status cannot override payment evidence.
9. Verify no duplicate certificate, payment, or allocation rows are created.

## Assignment Cancellation Test

1. On PC A, create a person assignment tied to the synced project.
2. Collect enough client payment evidence to earn part of the assignment.
3. Cancel the assignment and record the frozen earned amount.
4. Press Sync now on PC A, then on PC B.
5. Verify PC B shows the same:
   - `cancelled_at`
   - cancellation reason
   - frozen earned amount
6. Add later client payment evidence on either PC and sync both directions.
7. Verify the cancelled assignment's frozen earned amount does not change.
8. Attempt a person payment above lifecycle-aware due on a stale client.
9. Verify the current client rejects it or surfaces it as a conflict.

## Final Equality Check

After both PCs have completed Sync now twice with no new local edits, compare
the same project on both machines.

Both machines must show equal:

- Contract value
- Certified revenue
- Total cash in
- Outstanding
- Expenses
- Team payable
- Profit

Also verify:

- No duplicate payment rows.
- No duplicate certificate rows.
- No duplicate allocation rows.
- Sync protocol metadata is present in `sync_peers` when
  `supabase-0018-sync-peers.sql` was applied.
- Any rejected financial remote change is visible as reviewable conflict
  evidence and is not silently applied.

## Evidence To Save

Save these items with the release evidence:

- Application version, channel, and schema version from both PCs.
- Supabase preflight output.
- PC A and PC B timestamps for each Sync now.
- Screenshots or exported report values for the final equality check.
- Conflict IDs or screenshots for metadata and financial conflict cases.
- Confirmation that no production credentials or customer records were stored
  in the evidence bundle.
