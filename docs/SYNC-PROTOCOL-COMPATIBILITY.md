# Sync Protocol Compatibility

Current as of v0.7.1 Beta, schema 29.

NAMAA Finance treats synced financial rows as untrusted input. The authoritative
compatibility rule is still local validation: protected financial pulls are
applied only through the same Rust domain transactions used by local writes, and
invalid incoming rows are preserved as `REMOTE_DOMAIN_REJECTED` conflicts.

## Financial Protocol

`financial_protocol_version = 1` means the client validates synchronized
certificate, payment, allocation, assignment, person-payment, expense, approved
revision and variation-order mutations through the domain-aware sync paths.

Clients publish their current protocol to the optional Supabase `sync_peers`
table:

- `uuid`
- `application_version`
- `schema_version`
- `financial_protocol_version`
- `updated_at`
- `deleted_at`

The table is operational metadata only. It does not contain financial facts.

## Guard Behavior

On sync start, a v0.7.1 client:

1. signs in normally,
2. advertises its app/schema/financial protocol,
3. checks active peers,
4. fails closed with `SYNC_PROTOCOL_UPGRADE_REQUIRED` when a known peer
   advertises a financial protocol below the minimum supported version.

If the optional `sync_peers` table has not been installed, sync continues in
compatibility mode. This is intentional: existing Supabase workspaces can still
sync, and unsafe financial rows remain blocked by local Rust validation and
converted to conflicts. Installing `docs/supabase-0018-sync-peers.sql` enables
proactive peer blocking. Installing
`docs/supabase-0019-special-person-payments.sql` adds the schema-29
person-payment kind column used to distinguish earned payments from deliberate
special payments.

## Limitations

Older clients that do not know about `sync_peers` cannot advertise their
protocol. The current client therefore cannot identify every old peer before it
writes. This does not allow silent financial corruption: all protected financial
pulls are still validated locally before mutation.
