-- Milestone 9: durable backup metadata and compatibility marker.
ALTER TABLE backups_log ADD COLUMN filename TEXT;
ALTER TABLE backups_log ADD COLUMN database_version INTEGER;
ALTER TABLE backups_log ADD COLUMN application_version TEXT;
ALTER TABLE backups_log ADD COLUMN sha256_checksum TEXT;
ALTER TABLE backups_log ADD COLUMN backup_type TEXT;
ALTER TABLE backups_log ADD COLUMN source_device TEXT;

UPDATE backups_log SET
 filename=COALESCE(filename,path),
 database_version=COALESCE(database_version,13),
 application_version=COALESCE(application_version,'legacy'),
 backup_type=COALESCE(backup_type,kind),
 source_device=COALESCE(source_device,'unknown')
WHERE filename IS NULL OR database_version IS NULL OR application_version IS NULL OR backup_type IS NULL OR source_device IS NULL;

CREATE INDEX idx_backups_type_created ON backups_log(backup_type,created_at DESC,id DESC);
INSERT OR IGNORE INTO settings(key,value) VALUES('backup_retention_count','14');
CREATE TABLE app_metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO app_metadata(key,value) VALUES('application_id','com.mepfinance.app');
INSERT INTO app_metadata(key,value) VALUES('application_version','0.6.3');
INSERT INTO app_metadata(key,value) VALUES('schema_version','14');
PRAGMA user_version=14;
