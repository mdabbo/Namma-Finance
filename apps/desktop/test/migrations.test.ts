import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyMigrations, buildMigratedDb } from "./sync-harness";

/**
 * Upgrade-path safety: a database created by an early app version must survive
 * every later migration with its data intact. buildMigratedDb(through) applies
 * the real migration files 0001..through in order — the exact path an existing
 * user's database takes when they install a newer build.
 */

let db: DatabaseSync | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

describe("migration upgrade path", () => {
  it("upgrades legacy document paths to managed local metadata without losing the reference",()=>{
    db=buildMigratedDb(17);
    db.exec("INSERT INTO clients(name) VALUES('Docs Client')");
    db.exec("INSERT INTO projects(code,name,client_id,currency,fx_rate_micro) VALUES('DOC-1','Docs',1,'EGP',1000000)");
    db.exec("INSERT INTO documents(project_id,category,title,path) VALUES(1,'CONTRACT','Signed contract','C:/Legacy/signed.pdf')");
    const here=dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0018_managed_documents.sql"),"utf8"));
    db.prepare("INSERT INTO documents(project_id,category,title,document_uuid,original_filename,mime_type,size_bytes,sha256,storage_provider,version_number) VALUES(1,'OTHER','Legacy bad hash','33333333-3333-4333-8333-333333333333','bad.bin','application/octet-stream',1,?,'LOCAL_ONLY',1)").run("Z".repeat(64));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0019_document_cache_isolation.sql"),"utf8"));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0020_sync_conflict_safety.sql"),"utf8"));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0021_sync_conflict_remediation.sql"),"utf8"));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0022_numbering_safety.sql"),"utf8"));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0023_numbering_remediation.sql"),"utf8"));
    expect(db.prepare("SELECT title,path,local_cache_path,storage_provider,is_available_offline,version_number FROM documents").get()).toEqual({
      title:"Signed contract",path:"C:/Legacy/signed.pdf",local_cache_path:"C:/Legacy/signed.pdf",storage_provider:"LEGACY_LOCAL",is_available_offline:1,version_number:1,
    });
    const hash="a".repeat(64);
    db.prepare("INSERT INTO documents(project_id,category,title,document_uuid,original_filename,mime_type,size_bytes,sha256,storage_provider,version_number) VALUES(1,'DRAWING','v1','11111111-1111-4111-8111-111111111111','a.dwg','image/vnd.dwg',10,?,'LOCAL_ONLY',1)").run(hash);
    expect(()=>db!.prepare("INSERT INTO documents(project_id,category,title,document_uuid,original_filename,mime_type,size_bytes,sha256,storage_provider,version_number) VALUES(1,'DRAWING','duplicate','22222222-2222-4222-8222-222222222222','copy.dwg','image/vnd.dwg',10,?,'LOCAL_ONLY',1)").run(hash)).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO documents(project_id,category,title,document_uuid,original_filename,mime_type,size_bytes,sha256,storage_provider,version_number) VALUES(1,'DRAWING','v2','11111111-1111-4111-8111-111111111111','b.dwg','image/vnd.dwg',11,?,'LOCAL_ONLY',2)").run("b".repeat(64));
    expect(db.prepare("SELECT version_number FROM documents WHERE document_uuid='11111111-1111-4111-8111-111111111111' ORDER BY version_number").all()).toEqual([{version_number:1},{version_number:2}]);
    const before=db.prepare("SELECT updated_at FROM documents WHERE id=1").get();
    db.exec("UPDATE document_cache SET is_available_offline=0 WHERE document_id=1");
    expect(db.prepare("SELECT updated_at FROM documents WHERE id=1").get()).toEqual(before);
    expect(db.prepare("SELECT issue_code FROM data_quality_issues WHERE entity_type='document' AND field_name='sha256'").get()).toEqual({issue_code:"INVALID_SHA256"});
    expect(()=>db!.prepare("INSERT INTO documents(project_id,category,title,document_uuid,original_filename,mime_type,size_bytes,sha256,storage_provider,version_number) VALUES(1,'OTHER','Bad','44444444-4444-4444-8444-444444444444','bad.bin','application/octet-stream',1,?,'LOCAL_ONLY',1)").run("Z".repeat(64))).toThrow(/INVALID_DOCUMENT_SHA256/);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({user_version:23});
  });
  it("upgrades schema 15, preserves malformed source data, and records recoverable quality issues",()=>{
    db=buildMigratedDb(15);
    db.exec("INSERT INTO clients(name) VALUES('Quality Client')");
    db.exec("INSERT INTO projects(code,name,client_id,currency,fx_rate_micro,start_date,end_date) VALUES('Q-1','Quality',1,'EGP',1000000,'2026-03-10','2026-03-01')");
    db.exec("INSERT INTO contracts(project_id,number,value_minor,milestones) VALUES(1,'Q-C',10000,'{broken')");
    db.exec("INSERT INTO expenses(date,category_id,description,amount_minor) VALUES('2026-02-31',1,'Legacy invalid date',100)");
    const here=dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0016_domain_validation.sql"),"utf8"));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0017_domain_validation_audit.sql"),"utf8"));
    expect(db.prepare("SELECT milestones FROM contracts WHERE id=1").get()).toEqual({milestones:"{broken"});
    expect(db.prepare("SELECT field_name,issue_code FROM data_quality_issues ORDER BY id").all()).toEqual([
      {field_name:"milestones",issue_code:"MALFORMED_JSON"},
      {field_name:"date_range",issue_code:"END_BEFORE_START"},
      {field_name:"date",issue_code:"INVALID_CALENDAR_DATE"},
    ]);
    expect(()=>db!.exec("INSERT INTO expenses(date,category_id,description,amount_minor) VALUES('2026-02-31',1,'Bad',100)")).toThrow(/INVALID_EXPENSE_DATE/);
    db.exec("INSERT INTO projects(code,name,client_id,currency,fx_rate_micro) VALUES('Q-2','Valid',1,'EGP',1000000)");
    db.exec("INSERT INTO contracts(project_id,number,value_minor,signed_date) VALUES(2,'Q-C2',10000,'2026-03-10')");
    db.exec("UPDATE contracts SET drawings='{future-corruption' WHERE id=2");
    expect(db.prepare("SELECT issue_code FROM data_quality_issues WHERE entity_type='contract' AND entity_id=2 AND field_name='drawings' AND resolved_at IS NULL").get()).toEqual({issue_code:"MALFORMED_JSON"});
    db.exec("UPDATE contracts SET drawings='[]' WHERE id=2");
    expect(db.prepare("SELECT COUNT(*) AS count FROM data_quality_issues WHERE entity_type='contract' AND entity_id=2 AND field_name='drawings' AND resolved_at IS NULL").get()).toEqual({count:0});
    expect(()=>db!.exec("INSERT INTO payments(contract_id,number,date,amount_minor,method) VALUES(2,'P-early','2026-03-09',100,'CASH')")).toThrow(/PAYMENT_BEFORE_CONTRACT_DATE/);
    expect(()=>db!.exec("INSERT INTO payment_certificates(contract_id,seq,number,date,submission_date,due_date_override,gross_minor) VALUES(2,1,'PC-1','2026-03-10','2026-03-10','2026-03-09',100)")).toThrow(/CONFIRMATION_REQUIRED/);
    db.exec("INSERT INTO payment_certificates(contract_id,seq,number,date,submission_date,due_date_override,due_date_confirmed_at,gross_minor) VALUES(2,1,'PC-1','2026-03-10','2026-03-10','2026-03-09',datetime('now'),100)");
    db.exec("INSERT INTO payment_certificates(contract_id,seq,number,date,gross_minor) VALUES(2,2,'PC-2','2026-03-08',100)");
    expect(db.prepare("SELECT issue_code FROM data_quality_issues WHERE entity_type='payment_certificate' AND entity_id=(SELECT id FROM payment_certificates WHERE number='PC-2')").get()).toEqual({issue_code:"SEQUENCE_DATE_INCONSISTENT"});
    db.exec("UPDATE payment_certificates SET date='2026-03-11' WHERE number='PC-2'");
    expect(db.prepare("SELECT COUNT(*) AS count FROM data_quality_issues WHERE field_name='sequence_date' AND resolved_at IS NULL").get()).toEqual({count:0});
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({user_version:17});
  });

  it("upgrades schema 14 forward and records complete backup audit evidence", () => {
    db=buildMigratedDb(14);
    const here=dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0015_backup_audit_hardening.sql"),"utf8"));
    db.exec("INSERT INTO backups_log(path,kind,filename,database_version,application_version,sha256_checksum,backup_type,source_device) VALUES('C:/secret/test.db','MANUAL','test.db',15,'0.6.3','abc','SAFETY','device-a')");
    const row=db.prepare("SELECT after_json FROM audit_logs WHERE entity_type='backup' ORDER BY id DESC LIMIT 1").get() as {after_json:string};
    const evidence=JSON.parse(row.after_json);
    expect(evidence).toMatchObject({backupType:"SAFETY",filename:"test.db",databaseVersion:15,sha256Checksum:"abc",sourceDevice:"device-a",path:"[REDACTED]"});
    expect(row.after_json).not.toContain("C:/secret");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({user_version:15});
  });

  it("upgrades schema 13 to backup metadata schema 14 without losing backup history", () => {
    db=buildMigratedDb(13);
    db.exec("INSERT INTO backups_log(path,kind) VALUES('C:/legacy.db','MANUAL')");
    const here=dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0014_backup_hardening.sql"),"utf8"));
    expect(db.prepare("SELECT path,kind,filename,database_version,application_version,backup_type,source_device FROM backups_log").get()).toEqual({path:"C:/legacy.db",kind:"MANUAL",filename:"C:/legacy.db",database_version:13,application_version:"legacy",backup_type:"MANUAL",source_device:"unknown"});
    expect(db.prepare("PRAGMA user_version").get()).toEqual({user_version:14});
    expect(db.prepare("SELECT value FROM app_metadata WHERE key='application_id'").get()).toEqual({value:"com.mepfinance.app"});
  });

  it("upgrades audit schema 12 to remediation schema 13 without losing history", () => {
    db = buildMigratedDb(12);
    db.exec("INSERT INTO audit_logs(device_id,action,entity_type,source,application_version) VALUES('legacy-device','CREATE','payment','DESKTOP','0.6.0')");
    const here = dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0013_audit_remediation.sql"),"utf8"));
    expect(db.prepare("SELECT action,application_version,finalized FROM audit_logs").get()).toEqual({ action: "CREATE", application_version: "0.6.3", finalized: 1 });
    expect(() => db!.exec("UPDATE audit_logs SET action='TAMPER'")).toThrow(/AUDIT_LOG_IMMUTABLE/);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("upgrades schema 11 to audit schema 12 without changing existing financial rows", () => {
    db = buildMigratedDb(11);
    db.exec(`
      INSERT INTO clients(name) VALUES('Audit Legacy');
      INSERT INTO projects(code,name,client_id,currency,fx_rate_micro) VALUES('AUD-LEGACY','Legacy',1,'EGP',1000000);
      INSERT INTO contracts(project_id,number,value_minor) VALUES(1,'AUD-C',750000);
    `);
    const before = db.prepare("SELECT id,number,value_minor FROM contracts").all();
    const here = dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here,"..","src-tauri","migrations","0012_audit_log.sql"),"utf8"));
    expect(db.prepare("SELECT id,number,value_minor FROM contracts").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get()).toEqual({ count: 0 });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("upgrades schema 10 to allocation schema 11 with uniqueness and integrity intact", () => {
    db = buildMigratedDb(10);
    db.exec(`
      INSERT INTO clients (name) VALUES ('Allocation Legacy');
      INSERT INTO projects (code,name,client_id,currency,fx_rate_micro) VALUES ('PRJ-ALLOC','Legacy',1,'EGP',1000000);
      INSERT INTO contracts (project_id,number,value_minor) VALUES (1,'C-ALLOC',500000);
      INSERT INTO contract_revisions (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
        VALUES (1,1,'2026-01-01',500000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000,'Initial',datetime('now'));
      INSERT INTO payment_certificates (contract_id,seq,number,date,gross_minor,status,contract_revision_id,
        contract_value_minor_snapshot,vat_bp_snapshot,retention_bp_snapshot,withholding_bp_snapshot,
        advance_minor_snapshot,advance_method_snapshot,payment_terms_days_snapshot,currency_snapshot,fx_rate_micro_snapshot)
        VALUES (1,1,'PC-ALLOC','2026-01-02',100000,'APPROVED',1,500000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000);
      INSERT INTO payments (contract_id,kind,number,date,amount_minor,method) VALUES (1,'CERTIFICATE','PAY-ALLOC','2026-01-03',50000,'CASH');
      INSERT INTO payment_certificate_allocations (payment_id,certificate_id,amount_minor) VALUES (1,1,50000);
    `);
    const here = dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here, "..", "src-tauri", "migrations", "0011_payment_allocation_integrity.sql"), "utf8"));

    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db!.exec("INSERT INTO payment_certificate_allocations (payment_id,certificate_id,amount_minor) VALUES (1,1,1)"))
      .toThrow();
  });

  it("preserves and flags legacy duplicate allocations while blocking new duplicates", () => {
    db = buildMigratedDb(10);
    db.exec(`
      INSERT INTO clients (name) VALUES ('Duplicate Legacy');
      INSERT INTO projects (code,name,client_id,currency,fx_rate_micro) VALUES ('PRJ-DUP','Legacy',1,'EGP',1000000);
      INSERT INTO contracts (project_id,number,value_minor) VALUES (1,'C-DUP',500000);
      INSERT INTO contract_revisions (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
        VALUES (1,1,'2026-01-01',500000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000,'Initial',datetime('now'));
      INSERT INTO payment_certificates (contract_id,seq,number,date,gross_minor,status,contract_revision_id,
        contract_value_minor_snapshot,vat_bp_snapshot,retention_bp_snapshot,withholding_bp_snapshot,
        advance_minor_snapshot,advance_method_snapshot,payment_terms_days_snapshot,currency_snapshot,fx_rate_micro_snapshot)
        VALUES (1,1,'PC-DUP','2026-01-02',100000,'APPROVED',1,500000,0,0,0,0,'PROPORTIONAL',30,'EGP',1000000);
      INSERT INTO payments (contract_id,kind,number,date,amount_minor,method) VALUES (1,'CERTIFICATE','PAY-DUP','2026-01-03',50000,'CASH');
      INSERT INTO payment_certificate_allocations (payment_id,certificate_id,amount_minor) VALUES (1,1,20000),(1,1,30000);
    `);
    const here = dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here, "..", "src-tauri", "migrations", "0011_payment_allocation_integrity.sql"), "utf8"));

    expect(db.prepare("SELECT COUNT(*) AS n, SUM(amount_minor) AS total, SUM(integrity_exception) AS flagged FROM payment_certificate_allocations").get())
      .toEqual({ n: 2, total: 50_000, flagged: 1 });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db!.exec("INSERT INTO payment_certificate_allocations (payment_id,certificate_id,amount_minor) VALUES (1,1,1)"))
      .toThrow("DUPLICATE_CERTIFICATE_ALLOCATION");
  });

  it("upgrades schema 9 to schema 10 with immutable approved revisions", () => {
    db = buildMigratedDb(9);
    db.exec(`
      INSERT INTO clients (name) VALUES ('Guard Legacy');
      INSERT INTO projects (code,name,client_id,currency,fx_rate_micro) VALUES ('PRJ-GUARD','Legacy',1,'EGP',1000000);
      INSERT INTO contracts (project_id,number,value_minor) VALUES (1,'C-GUARD',500000);
      INSERT INTO contract_revisions (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
        VALUES (1,1,'2026-01-01',500000,1400,500,0,0,'PROPORTIONAL',30,'EGP',1000000,'Legacy approved',datetime('now'));
    `);
    const here = dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here, "..", "src-tauri", "migrations", "0010_contract_revision_integrity.sql"), "utf8"));

    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db!.exec("UPDATE contract_revisions SET vat_bp=1500 WHERE id=1")).toThrow("APPROVED_CONTRACT_REVISION_IMMUTABLE");
  });

  it("upgrades schema 8 to revision schema 9 and snapshots existing certificates", () => {
    db = buildMigratedDb(8);
    db.exec(`
      INSERT INTO clients (name) VALUES ('Revision Legacy');
      INSERT INTO projects (code,name,client_id,currency,fx_rate_micro) VALUES ('PRJ-R9','Legacy',1,'EGP',1000000);
      INSERT INTO contracts (project_id,number,value_minor,vat_bp,retention_bp) VALUES (1,'C-R9',500000,1400,500);
      INSERT INTO payment_certificates (contract_id,seq,number,date,gross_minor,status) VALUES (1,1,'PC-R9','2026-01-01',100000,'APPROVED');
    `);
    const here = dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here, "..", "src-tauri", "migrations", "0009_contract_revisions.sql"), "utf8"));

    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM contract_revisions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT contract_revision_id,vat_bp_snapshot,retention_bp_snapshot FROM payment_certificates").get())
      .toEqual({ contract_revision_id: 1, vat_bp_snapshot: 1400, retention_bp_snapshot: 500 });
  });

  it("upgrades schema 7 to lifecycle schema 8 without losing financial history", () => {
    db = buildMigratedDb(7);
    db.exec(`
      INSERT INTO clients (name) VALUES ('Lifecycle Legacy');
      INSERT INTO projects (code,name,client_id,currency,fx_rate_micro) VALUES ('PRJ-LIFE','Legacy',1,'EGP',1000000);
      INSERT INTO contracts (project_id,number,value_minor) VALUES (1,'C-LIFE',100000);
      INSERT INTO payments (contract_id,kind,number,date,amount_minor,method,deleted_at)
        VALUES (1,'ADVANCE','OLD-VOID','2026-01-01',1000,'CASH','2026-02-01 00:00:00');
    `);
    const here = dirname(fileURLToPath(import.meta.url));
    db.exec(readFileSync(join(here, "..", "src-tauri", "migrations", "0008_financial_record_lifecycle.sql"), "utf8"));

    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM clients").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM contracts").get()).toEqual({ n: 1 });
    const payment = db.prepare("SELECT deleted_at, voided_at, void_reason FROM payments").get() as Record<string, unknown>;
    expect(payment.voided_at).toBe(payment.deleted_at);
    expect(payment.void_reason).toBe("Legacy soft deletion");
  });

  it("upgrades a populated v0.1 database through the complete migration chain without data loss", () => {
    // Start at the Phase-1 schema and put real data in it.
    db = buildMigratedDb(2); // 0001_initial + 0002_seed
    db.exec(`
      INSERT INTO clients (name) VALUES ('Legacy Client');
      INSERT INTO projects (code, name, client_id, currency, fx_rate_micro)
        VALUES ('PRJ-2026-001', 'Legacy Project', 1, 'EGP', 1000000);
      INSERT INTO contracts (project_id, number, value_minor)
        VALUES (1, 'C-1', 5000000);
      INSERT INTO payment_certificates (contract_id, seq, number, date, gross_minor, status)
        VALUES (1, 1, 'PC-1', '2026-03-01', 2000000, 'APPROVED');
    `);
    applyMigrations(db, 2);

    // Continue on the same populated database, exactly as an installed app does.
    expect(db.prepare("SELECT name FROM clients WHERE id=1").get()).toEqual({ name: "Legacy Client" });
    expect(db.prepare("SELECT code,name FROM projects WHERE id=1").get()).toEqual({ code: "PRJ-2026-001", name: "Legacy Project" });
    expect(db.prepare("SELECT number,value_minor FROM contracts WHERE id=1").get()).toEqual({ number: "C-1", value_minor: 5_000_000 });
    expect(db.prepare("SELECT number,gross_minor,status FROM payment_certificates WHERE id=1").get()).toEqual({ number: "PC-1", gross_minor: 2_000_000, status: "APPROVED" });

    // Integrity + FK health after every currently registered migration.
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // Phase-2 and sync tables exist
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    for (const t of ["project_stages", "documents", "recurring_expenses", "sync_state", "sync_tombstones"]) {
      expect(tables.has(t)).toBe(true);
    }

    // sync columns present on a core table
    const clientCols = new Set(
      (db.prepare("PRAGMA table_info(clients)").all() as { name: string }[]).map((c) => c.name),
    );
    expect(clientCols.has("sync_uuid")).toBe(true);
    expect(clientCols.has("updated_at")).toBe(true);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 23 });
  });

  it("backfills sync_uuid and updated_at on rows that predate the sync migration", () => {
    // A DB at the Phase-2 schema (no sync columns yet) with existing rows.
    db = buildMigratedDb(5); // through 0005, before 0006_sync_tracking
    db.exec("INSERT INTO clients (name) VALUES ('Pre-Sync Client');");
    const before = db.prepare("PRAGMA table_info(clients)").all() as { name: string }[];
    expect(before.some((c) => c.name === "sync_uuid")).toBe(false);
    db.close();

    // Now the full chain including 0006 — every pre-existing row must get a uuid.
    db = buildMigratedDb();
    db.exec("INSERT INTO clients (name) VALUES ('Pre-Sync Client');");
    const row = db.prepare("SELECT sync_uuid, updated_at FROM clients").get() as { sync_uuid: string; updated_at: string };
    expect(row.sync_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.updated_at).toBeTruthy();
  });
});
