import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { applyMigrations, buildMigratedDb } from "./sync-harness";

/**
 * Baseline acceptance (v0.7.0 database rebase, Milestone 7).
 *
 * The development chain 0001..0024 was consolidated into 0001_baseline.sql +
 * 0002_seed_reference_data.sql, so upgrade-path tests no longer have a path to
 * walk: there is exactly one way to create a database. What still has to hold
 * is that a freshly created database carries the complete final schema, the
 * seeded reference data, and every financial integrity constraint the old
 * chain accumulated. Those constraints are asserted here directly, so the
 * guarantees the retired upgrade tests protected remain covered.
 *
 * The full pre-rebase history stays reachable at the git tags
 * pre-ui-redesign-v0.6.0 and pre-db-rebase-v0.6.7.
 */

let db: DatabaseSync | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

function freshDb(): DatabaseSync {
  db = buildMigratedDb();
  return db;
}

/** A minimal but complete contract chain used by the constraint assertions. */
function seedContract(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO clients (name) VALUES ('Baseline Client');
    INSERT INTO projects (code,name,client_id,currency,fx_rate_micro)
      VALUES ('BASE-2026-001','Baseline Project',1,'EGP',1000000);
    INSERT INTO contracts (project_id,number,value_minor,signed_date)
      VALUES (1,'BASE-C-1',500000,'2026-01-01');
    INSERT INTO contract_revisions
      (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,
       withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,
       fx_rate_micro,reason,approved_at)
      VALUES (1,1,'2026-01-01',500000,1400,500,0,0,'PROPORTIONAL',30,'EGP',1000000,'Initial',datetime('now'));
    INSERT INTO payment_certificates
      (contract_id,seq,number,date,gross_minor,status,contract_revision_id,
       contract_value_minor_snapshot,vat_bp_snapshot,retention_bp_snapshot,withholding_bp_snapshot,
       advance_minor_snapshot,advance_method_snapshot,payment_terms_days_snapshot,
       currency_snapshot,fx_rate_micro_snapshot)
      VALUES (1,1,'BASE-PC-1','2026-01-02',100000,'APPROVED',1,500000,1400,500,0,0,'PROPORTIONAL',30,'EGP',1000000);
    INSERT INTO payments (contract_id,kind,number,date,amount_minor,method)
      VALUES (1,'CERTIFICATE','BASE-PAY-1','2026-01-03',50000,'CASH');
    INSERT INTO payment_certificate_allocations (payment_id,certificate_id,amount_minor)
      VALUES (1,1,50000);
  `);
}

describe("baseline database creation", () => {
  it("creates a healthy database carrying the final schema identity", () => {
    const database = freshDb();
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // Schema identity is 28: the baseline recreates schema 24, then the
    // forward migrations carry it to 25 (assignment lifecycle), 26 (cancellation
    // evidence integrity), 27 (truthful audit version) and 28 (sync-domain
    // conflict evidence), so no database can claim a version whose shape differs.
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 28 });
    expect(database.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get())
      .toEqual({ value: "28" });
    expect(database.prepare("SELECT value FROM app_metadata WHERE key='application_id'").get())
      .toEqual({ value: "com.mepfinance.app" });
  });

  /**
   * Release regression: a fresh 0.7.0 database stamped every audit row with
   * application_version '0.6.3' — a version that never shipped this schema.
   * audit_logs is immutable by trigger, so a wrong stamp can never be corrected
   * after the fact.
   */
  it("stamps new audit records with the shipping application version", () => {
    const database = freshDb();
    database.exec("INSERT INTO clients (name) VALUES ('Version Probe')");
    expect(database.prepare(
      "SELECT application_version FROM audit_logs ORDER BY id DESC LIMIT 1",
    ).get()).toEqual({ application_version: "0.7.1" });

    // No retired 0.6.x literal may remain on the live audit path.
    const finalize = (database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='finalize_audit_insert'",
    ).get() as { sql: string }).sql;
    expect(finalize).not.toMatch(/0\.6\.\d+/);
  });

  /**
   * Milestone 2 regression. The schema-27 migration once carried
   *
   *     UPDATE audit_logs SET application_version='0.7.0'
   *     WHERE application_version IN ('0.6.0','0.6.3');
   *
   * `prevent_audit_update` permits only finalising a fresh row and binding a
   * NULL entity_uuid, so on any database holding one finalized 0.6.x-stamped
   * row that statement raised AUDIT_LOG_IMMUTABLE, the migration aborted, and
   * user_version stayed at 26 — an unopenable database. Reproduced before the
   * correction; asserted here so it cannot return.
   */
  it("upgrades a schema-26 database that already holds finalized 0.6.x audit rows", () => {
    // Build the exact pre-migration state: schema 26, one finalized audit row
    // stamped by the retired 0.6.x context default.
    db = buildMigratedDb(4);
    const database = db;
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    database.exec("INSERT INTO clients (name) VALUES ('Legacy Row')");
    const historical = database.prepare(
      "SELECT application_version, finalized FROM audit_logs ORDER BY id",
    ).all() as { application_version: string; finalized: number }[];
    expect(historical).toHaveLength(1);
    expect(historical[0]!.finalized).toBe(1);
    expect(["0.6.0", "0.6.3"]).toContain(historical[0]!.application_version);

    // The remaining forward migrations must apply, not abort.
    expect(() => applyMigrations(database, 4)).not.toThrow();
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 28 });
    expect(database.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get())
      .toEqual({ value: "28" });

    // The historical row keeps the version that actually wrote it: a row
    // stamped 0.6.3 is TRUE, and rewriting it would replace an accurate record
    // with a tidier falsehood.
    expect(database.prepare("SELECT application_version FROM audit_logs ORDER BY id LIMIT 1").get())
      .toEqual({ application_version: historical[0]!.application_version });

    // Everything written from here on carries the shipping version.
    expect(database.prepare("SELECT application_version FROM audit_context WHERE id=1").get())
      .toEqual({ application_version: "0.7.1" });
    database.exec("INSERT INTO clients (name) VALUES ('After Upgrade')");
    expect(database.prepare("SELECT application_version FROM audit_logs ORDER BY id DESC LIMIT 1").get())
      .toEqual({ application_version: "0.7.1" });
  });

  /**
   * The migration must never reinstate a historical-rewrite statement, and must
   * never buy its way past the trigger by dropping or relaxing it.
   */
  it("keeps the schema-27 migration free of audit rewrites and immutability weakening", () => {
    const sql = readFileSync(
      join(import.meta.dirname, "..", "src-tauri", "migrations", "0005_audit_version_baseline.sql"),
      "utf8",
    );
    // Strip comments (the file documents the removed statement on purpose) and
    // trigger bodies (finalize_audit_insert legitimately updates the row it is
    // finalising). What must not exist is a TOP-LEVEL write to audit_logs.
    const executable = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    const topLevel = executable.replace(/CREATE TRIGGER[\s\S]*?\nEND;/gi, "");
    expect(topLevel).not.toMatch(/UPDATE\s+audit_logs/i);
    expect(topLevel).not.toMatch(/DELETE\s+FROM\s+audit_logs/i);
    expect(executable).not.toMatch(/DROP\s+TRIGGER\s+prevent_audit_(update|delete)/i);
    // The one trigger it does replace is the version-stamping one.
    expect(executable).toMatch(/DROP TRIGGER finalize_audit_insert/);
  });

  it("refuses to update or delete an audit row on a fresh schema-27 database", () => {
    const database = freshDb();
    database.exec("INSERT INTO clients (name) VALUES ('Immutable Probe')");
    const { id } = database.prepare("SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1").get() as { id: number };
    expect(() => database.exec(`UPDATE audit_logs SET application_version='9.9.9' WHERE id=${id}`))
      .toThrow(/AUDIT_LOG_IMMUTABLE/);
    expect(() => database.exec(`DELETE FROM audit_logs WHERE id=${id}`))
      .toThrow(/AUDIT_LOG_IMMUTABLE/);
  });

  it("seeds reference data without fabricating audit activity", () => {
    const database = freshDb();
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs").get()).toEqual({ count: 0 });
    // The reference rows themselves are present — the seed ran, it just ran
    // before the audit triggers exist.
    const categories = database.prepare("SELECT COUNT(*) AS count FROM expense_categories").get() as { count: number };
    expect(categories.count).toBeGreaterThan(0);
    const currencies = database.prepare("SELECT COUNT(*) AS count FROM currencies").get() as { count: number };
    expect(currencies.count).toBeGreaterThan(0);
  });

  it("carries the assignment lifecycle columns", () => {
    const database = freshDb();
    const columns = new Set(
      (database.prepare("PRAGMA table_info(project_assignments)").all() as { name: string }[])
        .map((column) => column.name),
    );
    for (const column of [
      "lifecycle_status", "completed_at", "cancelled_at",
      "cancellation_reason", "earned_minor_at_cancellation", "archived_at",
    ]) {
      expect(columns.has(column), `missing column ${column}`).toBe(true);
    }
  });

  it("makes cancellation evidence final and refuses it on live work", () => {
    const database = freshDb();
    const triggers = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[])
        .map((row) => row.name),
    );
    for (const trigger of [
      "validate_cancellation_evidence_final",
      "validate_frozen_earned_requires_cancellation_insert",
      "validate_frozen_earned_requires_cancellation_update",
    ]) {
      expect(triggers.has(trigger), `missing trigger ${trigger}`).toBe(true);
    }
  });

  it("carries every table the application depends on", () => {
    const database = freshDb();
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((r) => r.name),
    );
    for (const table of [
      "clients", "projects", "contracts", "contract_revisions", "variation_orders",
      "payment_certificates", "payments", "payment_certificate_allocations",
      "expenses", "expense_categories", "recurring_expenses",
      "people", "project_assignments", "person_payments", "time_entries",
      "project_stages", "documents", "document_cache",
      "audit_logs", "audit_context", "data_quality_issues",
      "sync_state", "sync_tombstones", "sync_conflicts",
      "numbering_sequences", "backups_log", "settings", "currencies", "app_metadata",
    ]) {
      expect(tables.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it("seeds reference data and starts with an empty, unaudited ledger", () => {
    const database = freshDb();
    expect(database.prepare("SELECT COUNT(*) AS n FROM expense_categories").get()).toEqual({ n: 12 });
    expect(database.prepare("SELECT fx_rate_micro FROM currencies WHERE code='EGP'").get())
      .toEqual({ fx_rate_micro: 1_000_000 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM currencies").get()).toEqual({ n: 11 });
    expect(database.prepare("SELECT source,application_version FROM audit_context WHERE id=1").get())
      .toEqual({ source: "DESKTOP", application_version: "0.7.1" });

    // A brand-new workspace has no financial records and no audit history:
    // seeding reference data must not manufacture activity.
    for (const table of ["clients", "projects", "contracts", "payment_certificates", "payments", "expenses", "audit_logs"]) {
      expect(
        database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
        `${table} should start empty`,
      ).toEqual({ n: 0 });
    }

    // Numbering prefixes and the per-install device id are present.
    const settings = new Map(
      (database.prepare("SELECT key,value FROM settings").all() as { key: string; value: string }[])
        .map((r) => [r.key, r.value]),
    );
    for (const key of [
      "language", "theme", "base_currency", "project_code_prefix", "contract_number_prefix",
      "certificate_number_prefix", "payment_number_prefix", "expense_number_prefix",
      "overhead_rule", "backup_retention_count",
    ]) {
      expect(settings.has(key), `missing setting ${key}`).toBe(true);
    }
    expect(settings.get("device_id")).toMatch(/^[0-9a-f]{32}$/);
  });

  /**
   * The baseline is a generated dump, so it must not freeze values that the
   * original chain produced per install: shipping one set of category
   * sync_uuids would give every office the same sync identity, and a frozen
   * currency updated_at would misreport how fresh the FX rates are.
   */
  it("generates per-install identity rather than shipping frozen values", () => {
    const first = buildMigratedDb();
    const second = buildMigratedDb();
    try {
      const uuidsOf = (d: DatabaseSync) =>
        (d.prepare("SELECT sync_uuid FROM expense_categories ORDER BY id").all() as { sync_uuid: string }[])
          .map((r) => r.sync_uuid);
      const a = uuidsOf(first);
      const b = uuidsOf(second);

      expect(a).toHaveLength(12);
      expect(new Set(a).size).toBe(12);
      for (const uuid of a) {
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
      // Two independently created databases must not share sync identity.
      expect(a.some((uuid) => b.includes(uuid))).toBe(false);
      expect(
        (first.prepare("SELECT value FROM settings WHERE key='device_id'").get() as { value: string }).value,
      ).not.toBe(
        (second.prepare("SELECT value FROM settings WHERE key='device_id'").get() as { value: string }).value,
      );

      // FX freshness is stamped at install, not at baseline generation time.
      const stamped = (first.prepare("SELECT updated_at FROM currencies WHERE code='EGP'").get() as {
        updated_at: string;
      }).updated_at;
      expect(stamped).toBeTruthy();
      expect(stamped >= "2026-01-01").toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });

  it("generates sync identity for rows created on the baseline schema", () => {
    const database = freshDb();
    database.exec("INSERT INTO clients (name) VALUES ('Sync Identity')");
    const row = database.prepare("SELECT sync_uuid, updated_at FROM clients").get() as {
      sync_uuid: string; updated_at: string;
    };
    expect(row.sync_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.updated_at).toBeTruthy();
  });
});

describe("baseline financial integrity constraints", () => {
  it("rejects a duplicate certificate allocation", () => {
    const database = freshDb();
    seedContract(database);
    expect(() =>
      database.exec("INSERT INTO payment_certificate_allocations (payment_id,certificate_id,amount_minor) VALUES (1,1,1)"),
    ).toThrow("DUPLICATE_CERTIFICATE_ALLOCATION");
  });

  it("keeps approved contract revisions immutable", () => {
    const database = freshDb();
    seedContract(database);
    expect(() => database.exec("UPDATE contract_revisions SET vat_bp=1500 WHERE id=1"))
      .toThrow("APPROVED_CONTRACT_REVISION_IMMUTABLE");
  });

  it("keeps the audit log append-only and stamps running context", () => {
    const database = freshDb();
    seedContract(database);
    const entry = database.prepare(
      "SELECT action,entity_type,source,application_version,finalized FROM audit_logs WHERE entity_type='contract' ORDER BY id LIMIT 1",
    ).get();
    expect(entry).toMatchObject({
      action: "CREATE",
      entity_type: "contract",
      source: "DESKTOP",
      application_version: "0.7.1",
      finalized: 1,
    });
    expect(() => database.exec("UPDATE audit_logs SET action='TAMPER'")).toThrow(/AUDIT_LOG_IMMUTABLE/);
    expect(() => database.exec("DELETE FROM audit_logs")).toThrow(/AUDIT_LOG_IMMUTABLE/);
  });

  it("rejects payments dated before their contract and impossible calendar dates", () => {
    const database = freshDb();
    seedContract(database);
    expect(() =>
      database.exec("INSERT INTO payments (contract_id,number,date,amount_minor,method) VALUES (1,'P-early','2025-12-31',100,'CASH')"),
    ).toThrow(/PAYMENT_BEFORE_CONTRACT_DATE/);
    expect(() =>
      database.exec("INSERT INTO expenses (date,category_id,description,amount_minor) VALUES ('2026-02-31',1,'Impossible',100)"),
    ).toThrow(/INVALID_EXPENSE_DATE/);
  });

  it("requires confirmation for a due date that precedes submission", () => {
    const database = freshDb();
    seedContract(database);
    expect(() =>
      database.exec(`INSERT INTO payment_certificates (contract_id,seq,number,date,submission_date,due_date_override,gross_minor)
                     VALUES (1,2,'BASE-PC-2','2026-02-01','2026-02-01','2026-01-31',100)`),
    ).toThrow(/CONFIRMATION_REQUIRED/);
    database.exec(`INSERT INTO payment_certificates (contract_id,seq,number,date,submission_date,due_date_override,due_date_confirmed_at,gross_minor)
                   VALUES (1,2,'BASE-PC-2','2026-02-01','2026-02-01','2026-01-31',datetime('now'),100)`);
    expect(database.prepare("SELECT COUNT(*) AS n FROM payment_certificates").get()).toEqual({ n: 2 });
  });

  it("records recoverable data-quality issues instead of rewriting bad values", () => {
    const database = freshDb();
    seedContract(database);
    database.exec("UPDATE contracts SET milestones='{broken' WHERE id=1");
    expect(database.prepare("SELECT milestones FROM contracts WHERE id=1").get()).toEqual({ milestones: "{broken" });
    expect(
      database.prepare(
        "SELECT issue_code FROM data_quality_issues WHERE entity_type='contract' AND field_name='milestones' AND resolved_at IS NULL",
      ).get(),
    ).toEqual({ issue_code: "MALFORMED_JSON" });
    database.exec("UPDATE contracts SET milestones='[]' WHERE id=1");
    expect(
      database.prepare(
        "SELECT COUNT(*) AS n FROM data_quality_issues WHERE entity_type='contract' AND field_name='milestones' AND resolved_at IS NULL",
      ).get(),
    ).toEqual({ n: 0 });
  });

  it("redacts backup paths in audit evidence", () => {
    const database = freshDb();
    database.exec(`INSERT INTO backups_log(path,kind,filename,database_version,application_version,sha256_checksum,backup_type,source_device)
                   VALUES('C:/secret/test.db','MANUAL','test.db',25,'0.7.0','abc','SAFETY','device-a')`);
    const row = database.prepare("SELECT after_json FROM audit_logs WHERE entity_type='backup' ORDER BY id DESC LIMIT 1").get() as {
      after_json: string;
    };
    expect(JSON.parse(row.after_json)).toMatchObject({
      backupType: "SAFETY", filename: "test.db", databaseVersion: 25, path: "[REDACTED]",
    });
    expect(row.after_json).not.toContain("C:/secret");
  });

  it("rejects document hashes that are not valid sha256", () => {
    const database = freshDb();
    seedContract(database);
    expect(() =>
      database.prepare(
        `INSERT INTO documents(project_id,category,title,document_uuid,original_filename,mime_type,size_bytes,sha256,storage_provider,version_number)
         VALUES(1,'OTHER','Bad','44444444-4444-4444-8444-444444444444','bad.bin','application/octet-stream',1,?,'LOCAL_ONLY',1)`,
      ).run("Z".repeat(64)),
    ).toThrow(/INVALID_DOCUMENT_SHA256/);
  });
});
