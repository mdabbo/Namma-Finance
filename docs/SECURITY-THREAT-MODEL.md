# NAMAA Finance security threat model (Milestone 10)

## Security boundary

NAMAA Finance is an offline-first financial desktop application. The trusted
boundary is the signed Tauri/Rust application, its SQLite database in the
Windows application-data directory, and the configured Supabase project.
Financial values remain integer minor units. The local application lock is an
access gate for a shared Windows session; **it is not database encryption**.

## Protected assets

- Contracts, certificates, payments, allocations, expenses and audit history.
- Client and personnel contact/bank details.
- Supabase access/refresh tokens and user identity.
- Backups and document attachments.

## Principal threats and controls

| Threat | Control in v0.6 hardening | Residual risk |
|---|---|---|
| WebView script injection | Restrictive CSP; React escaping; no raw HTML renderers; spreadsheet formula neutralization | Compromised third-party package inside the signed bundle remains trusted |
| Arbitrary filesystem access | Tauri filesystem scopes limited to app data; user file access starts through an OS picker | Selected-file grants must remain narrow and short-lived |
| Local lock bypass | Rust Argon2id verification; corrupt/missing halves fail closed; exponential retry delay; password-free security audit events | SQLite is readable by the same OS user unless disk/SQLCipher encryption is deployed |
| Token theft | Supabase sessions are memory-only; passwords and tokens are not written to settings or logs | A process with access to application memory can read an active session |
| Unauthorized cloud access | Supabase RLS must enforce membership and role on every request; UI role is not an authority | The accompanying SQL must be deployed to each Supabase project |
| Financial mutation abuse | Multi-record payment, allocation, person-payment, project, contract and import operations use explicit Rust transaction commands | Some single-record CRUD still uses parameterized SQL through the Tauri SQL plugin; continue command migration in later hardening |
| Malicious exports | CSV/XLSX cells beginning with formula control characters are escaped | Recipients can deliberately remove the escape |
| Backup replacement | SHA-256 validation, SQLite integrity/FK/schema checks, safety backup and atomic replacement | Backups are not encrypted by default |

## Authentication and authorization rules

- User passwords are sent only to Supabase authentication or the local Argon2id command and are never stored.
- Supabase tokens stay in memory and are discarded when the process exits.
- Cached roles are display hints only and are not used as authorization truth.
- Supabase RLS is the final authority. Apply `supabase-security-hardening.sql`.
- The anon key is public client configuration, not a secret. Service-role keys must never be shipped in the app.

## Commercial encryption option

For deployments requiring protection from another process running as the same
Windows user, use BitLocker/EFS operational controls or add a separately scoped
SQLCipher build with OS credential storage for its key. This is not enabled by
the application lock and must not be represented as such.

## Security validation checklist

1. Attempt startup with a partial/corrupt lock credential: the application stays locked.
2. Confirm repeated bad passwords produce increasing retry delays and audit events without entered text.
3. Restart after Supabase login and confirm a new login is required.
4. Verify CSP violations appear in development tools and inline scripts do not execute.
5. Verify arbitrary paths outside app data fail unless selected in an OS dialog.
6. Apply and test RLS with Admin, Accountant, Engineer and an unregistered authenticated user.
7. Export cells beginning with `=`, `+`, `-`, and `@`; confirm Excel treats them as text.

