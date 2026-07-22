-- Milestone 9 audit remediation: retain complete, non-sensitive backup evidence.
DROP TRIGGER IF EXISTS audit_backup_insert;
CREATE TRIGGER audit_backup_insert AFTER INSERT ON backups_log BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,after_json,source)
 VALUES(
  (SELECT value FROM settings WHERE key='sync_email'),
  (SELECT value FROM settings WHERE key='device_id'),
  'BACKUP','backup',NEW.id,
  json_object(
   'kind',NEW.kind,'backupType',NEW.backup_type,'filename',NEW.filename,
   'databaseVersion',NEW.database_version,'applicationVersion',NEW.application_version,
   'sha256Checksum',NEW.sha256_checksum,'sourceDevice',NEW.source_device,'path','[REDACTED]'
  ),
  CASE WHEN NEW.backup_type='AUTO' THEN 'BACKGROUND' ELSE 'DESKTOP' END
 );
END;

UPDATE app_metadata SET value='15' WHERE key='schema_version';
PRAGMA user_version=15;
