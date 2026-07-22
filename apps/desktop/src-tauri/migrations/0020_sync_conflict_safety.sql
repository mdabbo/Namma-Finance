-- Milestone 13: forward-only, device-local sync conflict ledger.
-- These tables are intentionally not synchronized: they protect each device's
-- local financial truth and contain the snapshots needed for recovery.
CREATE TABLE sync_record_state(
 table_name TEXT NOT NULL,
 row_uuid TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 remote_updated_at TEXT NOT NULL,
 synced_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(table_name,row_uuid)
);

CREATE TABLE sync_conflicts(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 table_name TEXT NOT NULL,
 row_uuid TEXT NOT NULL,
 conflict_kind TEXT NOT NULL CHECK(conflict_kind IN ('CONCURRENT_EDIT','DELETE_VS_EDIT','DUPLICATE_RECORD')),
 local_json TEXT,
 remote_json TEXT,
 local_updated_at TEXT,
 remote_updated_at TEXT,
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
 resolution TEXT CHECK(resolution IN ('KEEP_LOCAL','KEEP_REMOTE')),
 resolution_note TEXT,
 detected_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 resolved_at TEXT,
 resolved_by TEXT
);
CREATE UNIQUE INDEX uq_sync_conflict_open ON sync_conflicts(table_name,row_uuid) WHERE status='OPEN';
CREATE INDEX idx_sync_conflict_status ON sync_conflicts(status,detected_at DESC);

CREATE TRIGGER audit_sync_conflict_resolution AFTER UPDATE OF status ON sync_conflicts
WHEN OLD.status='OPEN' AND NEW.status='RESOLVED'
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_uuid,before_json,after_json,reason,source,application_version)
 VALUES(COALESCE(NEW.resolved_by,(SELECT value FROM settings WHERE key='sync_email')),
        (SELECT value FROM settings WHERE key='device_id'),'SYNC_CONFLICT_RESOLVED',NEW.table_name,NEW.row_uuid,
        json_object('kind',NEW.conflict_kind,'local',json(NEW.local_json),'remote',json(NEW.remote_json)),
        json_object('resolution',NEW.resolution),NEW.resolution_note,'SYNC','0.6.4');
END;

PRAGMA user_version = 20;
INSERT INTO app_metadata(key,value) VALUES('schema_version','20') ON CONFLICT(key) DO UPDATE SET value='20';
INSERT INTO app_metadata(key,value) VALUES('application_version','0.6.4') ON CONFLICT(key) DO UPDATE SET value='0.6.4';
