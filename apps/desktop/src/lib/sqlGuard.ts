/**
 * Defense in depth for the remaining single-record repository mutations.
 * Schema changes, database attachment and stacked statements are available
 * only to Rust migrations/commands, never to feature code in the WebView.
 *
 * Transaction control is denied outright. `tauri-plugin-sql` executes each
 * statement against the pool and releases the connection between calls, so a
 * WebView `BEGIN IMMEDIATE` does not open a transaction the WebView owns — it
 * strands one on a shared connection, and the next statement from any caller
 * (a list refetch, the auto-sync tick, a Rust command's own transaction) joins
 * it and commits or rolls back with it. A multi-statement write therefore
 * belongs in a Rust atomic command, which holds the connection for the whole
 * transaction. Code that needs a boundary asks the database layer for one; it
 * never spells the boundary as SQL.
 *
 * Lives apart from the database module so the production layer and the
 * end-to-end browser bridge enforce the same rules from one implementation.
 */
export function assertRestrictedSql(sql: string, params: unknown[]): void {
  const normalized=sql.trim();
  if(!normalized) throw new Error("SQL_EMPTY");
  if(normalized.includes(";") || /--|\/\*/.test(normalized)) throw new Error("SQL_STACKED_OR_COMMENTED");
  if(/^(ATTACH|DETACH|PRAGMA|VACUUM|CREATE|ALTER|DROP|REINDEX)\b/i.test(normalized)) throw new Error("SQL_ADMIN_COMMAND_DENIED");
  if(/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(normalized)) throw new Error("SQL_TRANSACTION_CONTROL_DENIED");
  const allowed=/^(INSERT|UPDATE|DELETE)\b/i.test(normalized) || /^WITH\s+chosen\s+AS\s*\(/i.test(normalized);
  if(!allowed) throw new Error("SQL_MUTATION_NOT_ALLOWLISTED");
  const indexes=[...normalized.matchAll(/\$(\d+)/g)].map((match)=>Number(match[1]));
  if(indexes.some((index)=>index<1 || index>params.length)) throw new Error("SQL_PARAMETER_MISSING");
}
