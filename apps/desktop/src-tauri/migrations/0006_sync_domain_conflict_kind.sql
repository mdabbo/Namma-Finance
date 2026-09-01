-- Preserve protected sync domain rejections as first-class conflicts.
--
-- v0.7.1 sync hardening routes incoming financial mutations through the same
-- Rust domain validation used by local writes. A rejected remote mutation must
-- remain reviewable, so sync_conflicts needs an explicit kind for those rows.

CREATE TABLE sync_conflicts_v28(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 table_name TEXT NOT NULL,
 row_uuid TEXT NOT NULL,
 conflict_kind TEXT NOT NULL CHECK(conflict_kind IN ('CONCURRENT_EDIT','DELETE_VS_EDIT','DUPLICATE_RECORD','REMOTE_DOMAIN_REJECTED')),
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

INSERT INTO sync_conflicts_v28(
 id,table_name,row_uuid,conflict_kind,local_json,remote_json,local_updated_at,
 remote_updated_at,status,resolution,resolution_note,detected_at,resolved_at,resolved_by
)
SELECT
 id,table_name,row_uuid,conflict_kind,local_json,remote_json,local_updated_at,
 remote_updated_at,status,resolution,resolution_note,detected_at,resolved_at,resolved_by
FROM sync_conflicts;

DROP TRIGGER audit_sync_conflict_resolution;
DROP TABLE sync_conflicts;
ALTER TABLE sync_conflicts_v28 RENAME TO sync_conflicts;

CREATE TRIGGER audit_sync_conflict_resolution AFTER UPDATE OF status ON sync_conflicts
WHEN OLD.status='OPEN' AND NEW.status='RESOLVED'
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_uuid,before_json,after_json,reason,source,application_version)
 VALUES(COALESCE(NEW.resolved_by,(SELECT value FROM settings WHERE key='sync_email')),
        (SELECT value FROM settings WHERE key='device_id'),'SYNC_CONFLICT_RESOLVED',NEW.table_name,NEW.row_uuid,
        json_object('kind',NEW.conflict_kind,'detectedAt',NEW.detected_at),
        json_object('resolution',NEW.resolution,'resolvedAt',NEW.resolved_at),
        NEW.resolution_note,'SYNC','0.7.1');
END;

UPDATE audit_context SET application_version = '0.7.1' WHERE id = 1;
INSERT INTO app_metadata(key,value) VALUES('application_version','0.7.1')
ON CONFLICT(key) DO UPDATE SET value='0.7.1';

PRAGMA user_version = 28;
INSERT INTO app_metadata(key,value) VALUES('schema_version','28')
ON CONFLICT(key) DO UPDATE SET value='28';
