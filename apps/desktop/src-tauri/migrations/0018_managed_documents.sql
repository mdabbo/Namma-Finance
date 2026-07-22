-- Milestone 12: managed, versioned, device-portable document metadata.
-- Existing paths are preserved as legacy local cache references and are never synced.

DROP TRIGGER trg_documents_sync_init;
DROP TRIGGER trg_documents_sync_touch;
DROP TRIGGER trg_documents_sync_tomb;

CREATE TABLE documents_managed(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 category TEXT NOT NULL DEFAULT 'OTHER' CHECK(category IN('CONTRACT','BOQ','PROPOSAL','INVOICE','DRAWING','OTHER')),
 title TEXT NOT NULL,
 path TEXT,
 added_at TEXT NOT NULL DEFAULT(datetime('now')),
 sync_uuid TEXT,
 updated_at TEXT,
 document_uuid TEXT NOT NULL,
 original_filename TEXT NOT NULL,
 extension TEXT,
 mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
 size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes>=0),
 sha256 TEXT CHECK(sha256 IS NULL OR length(sha256)=64),
 storage_provider TEXT NOT NULL DEFAULT 'LOCAL_ONLY' CHECK(storage_provider IN('LOCAL_ONLY','SUPABASE','LEGACY_LOCAL')),
 cloud_storage_key TEXT,
 local_cache_path TEXT,
 version_number INTEGER NOT NULL DEFAULT 1 CHECK(version_number>0),
 uploaded_at TEXT,
 uploaded_by TEXT,
 is_available_offline INTEGER NOT NULL DEFAULT 0 CHECK(is_available_offline IN(0,1)),
 archived_at TEXT,
 UNIQUE(document_uuid,version_number)
);

INSERT INTO documents_managed(
 id,project_id,category,title,path,added_at,sync_uuid,updated_at,document_uuid,
 original_filename,storage_provider,local_cache_path,version_number,is_available_offline
)
SELECT id,project_id,category,title,path,added_at,sync_uuid,updated_at,
       COALESCE(sync_uuid,lower(hex(randomblob(16)))),title,'LEGACY_LOCAL',path,1,1
FROM documents;

DROP TABLE documents;
ALTER TABLE documents_managed RENAME TO documents;

CREATE INDEX idx_documents_project ON documents(project_id,archived_at,added_at);
CREATE UNIQUE INDEX idx_documents_sync_uuid ON documents(sync_uuid);
CREATE UNIQUE INDEX idx_documents_active_hash ON documents(project_id,sha256) WHERE archived_at IS NULL AND sha256 IS NOT NULL;

CREATE TRIGGER trg_documents_sync_init AFTER INSERT ON documents
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
 UPDATE documents SET
  sync_uuid=COALESCE(sync_uuid,lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',(abs(random())%4)+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))),
  updated_at=COALESCE(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 WHERE id=NEW.id;
END;
CREATE TRIGGER trg_documents_sync_touch AFTER UPDATE ON documents
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE documents SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END;
CREATE TRIGGER trg_documents_sync_tomb AFTER DELETE ON documents
WHEN OLD.sync_uuid IS NOT NULL
BEGIN INSERT INTO sync_tombstones(tbl,row_uuid) VALUES('documents',OLD.sync_uuid); END;

UPDATE app_metadata SET value='18' WHERE key='schema_version';
PRAGMA user_version=18;
