/**
 * Defense in depth for the remaining single-record repository mutations.
 * Schema changes, database attachment and stacked statements are available
 * only to Rust migrations/commands, never to feature code in the WebView.
 *
 * Lives apart from the database module so the production layer and the
 * end-to-end browser bridge enforce the same rules from one implementation.
 */
export function assertRestrictedSql(sql: string, params: unknown[]): void {
  const normalized=sql.trim();
  if(!normalized) throw new Error("SQL_EMPTY");
  if(normalized.includes(";") || /--|\/\*/.test(normalized)) throw new Error("SQL_STACKED_OR_COMMENTED");
  if(/^(ATTACH|DETACH|PRAGMA|VACUUM|CREATE|ALTER|DROP|REINDEX)\b/i.test(normalized)) throw new Error("SQL_ADMIN_COMMAND_DENIED");
  const allowed=/^(INSERT|UPDATE|DELETE|BEGIN IMMEDIATE|COMMIT|ROLLBACK)\b/i.test(normalized) || /^WITH\s+chosen\s+AS\s*\(/i.test(normalized);
  if(!allowed) throw new Error("SQL_MUTATION_NOT_ALLOWLISTED");
  const indexes=[...normalized.matchAll(/\$(\d+)/g)].map((match)=>Number(match[1]));
  if(indexes.some((index)=>index<1 || index>params.length)) throw new Error("SQL_PARAMETER_MISSING");
}
