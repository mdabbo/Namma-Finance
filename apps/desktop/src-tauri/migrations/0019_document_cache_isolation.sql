-- Milestone 12 audit: device cache state must never advance synced metadata clocks.
CREATE TABLE document_cache(
 document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 local_cache_path TEXT NOT NULL,
 is_available_offline INTEGER NOT NULL DEFAULT 1 CHECK(is_available_offline IN(0,1)),
 verified_at TEXT
);

INSERT INTO document_cache(document_id,local_cache_path,is_available_offline,verified_at)
SELECT id,local_cache_path,is_available_offline,
       CASE WHEN sha256 IS NOT NULL THEN datetime('now') END
FROM documents
WHERE local_cache_path IS NOT NULL;

INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'document',id,'sha256','INVALID_SHA256',sha256 FROM documents
WHERE sha256 IS NOT NULL AND (length(sha256)<>64 OR sha256 GLOB '*[^0-9a-f]*');

CREATE TRIGGER validate_document_metadata_insert BEFORE INSERT ON documents BEGIN
 SELECT CASE WHEN NEW.sha256 IS NOT NULL AND (length(NEW.sha256)<>64 OR NEW.sha256 GLOB '*[^0-9a-f]*') THEN RAISE(ABORT,'INVALID_DOCUMENT_SHA256') END;
 SELECT CASE WHEN NEW.storage_provider='SUPABASE' AND NEW.cloud_storage_key IS NULL THEN RAISE(ABORT,'CLOUD_DOCUMENT_KEY_REQUIRED') END;
END;
CREATE TRIGGER validate_document_metadata_update BEFORE UPDATE OF sha256,storage_provider,cloud_storage_key ON documents BEGIN
 SELECT CASE WHEN NEW.sha256 IS NOT NULL AND (length(NEW.sha256)<>64 OR NEW.sha256 GLOB '*[^0-9a-f]*') THEN RAISE(ABORT,'INVALID_DOCUMENT_SHA256') END;
 SELECT CASE WHEN NEW.storage_provider='SUPABASE' AND NEW.cloud_storage_key IS NULL THEN RAISE(ABORT,'CLOUD_DOCUMENT_KEY_REQUIRED') END;
END;

UPDATE app_metadata SET value='19' WHERE key='schema_version';
PRAGMA user_version=19;
