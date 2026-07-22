-- Milestone 13 audit remediation. Forward-only: do not alter migration 0020.
-- Conflict snapshots remain recoverable in sync_conflicts, but immutable audit
-- records must contain metadata only and never copy bank/reference/note fields.
DROP TRIGGER audit_sync_conflict_resolution;
CREATE TRIGGER audit_sync_conflict_resolution AFTER UPDATE OF status ON sync_conflicts
WHEN OLD.status='OPEN' AND NEW.status='RESOLVED'
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_uuid,before_json,after_json,reason,source,application_version)
 VALUES(COALESCE(NEW.resolved_by,(SELECT value FROM settings WHERE key='sync_email')),
        (SELECT value FROM settings WHERE key='device_id'),'SYNC_CONFLICT_RESOLVED',NEW.table_name,NEW.row_uuid,
        json_object('kind',NEW.conflict_kind,'detectedAt',NEW.detected_at),
        json_object('resolution',NEW.resolution,'resolvedAt',NEW.resolved_at),
        NEW.resolution_note,'SYNC','0.6.5');
END;

PRAGMA user_version = 21;
INSERT INTO app_metadata(key,value) VALUES('schema_version','21') ON CONFLICT(key) DO UPDATE SET value='21';
INSERT INTO app_metadata(key,value) VALUES('application_version','0.6.5') ON CONFLICT(key) DO UPDATE SET value='0.6.5';
