-- Milestone 3 dashboard independent-audit remediation. Forward-only.
-- Completes operational evidence for rows that drive dashboard alerts and
-- lets pooled readers use the immutable audit id as a consistency revision.

CREATE TRIGGER bind_audit_client_uuid AFTER UPDATE OF sync_uuid ON clients
WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL
BEGIN
  UPDATE audit_logs SET entity_uuid=NEW.sync_uuid
  WHERE entity_type='client' AND entity_id=NEW.id AND entity_uuid IS NULL;
END;

CREATE TRIGGER bind_audit_stage_uuid AFTER UPDATE OF sync_uuid ON project_stages
WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL
BEGIN
  UPDATE audit_logs SET entity_uuid=NEW.sync_uuid
  WHERE entity_type='project_stage' AND entity_id=NEW.id AND entity_uuid IS NULL;
END;

CREATE TRIGGER audit_client_insert AFTER INSERT ON clients
BEGIN
  INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
  VALUES(
    (SELECT value FROM settings WHERE key='sync_email'),
    (SELECT value FROM settings WHERE key='device_id'),
    'CREATE','client',NEW.id,COALESCE(NEW.sync_uuid,(SELECT sync_uuid FROM clients WHERE id=NEW.id)),
    json_object('name',NEW.name,'company',NEW.company,'sensitiveFields','[REDACTED]')
  );
END;

CREATE TRIGGER audit_client_update AFTER UPDATE ON clients
WHEN NEW.name IS NOT OLD.name OR NEW.company IS NOT OLD.company
BEGIN
  INSERT INTO audit_logs(
    user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json
  )
  VALUES(
    (SELECT value FROM settings WHERE key='sync_email'),
    (SELECT value FROM settings WHERE key='device_id'),
    'UPDATE','client',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),
    json_object('name',OLD.name,'company',OLD.company,'sensitiveFields','[REDACTED]'),
    json_object('name',NEW.name,'company',NEW.company,'sensitiveFields','[REDACTED]')
  );
END;

CREATE TRIGGER audit_project_operational_update AFTER UPDATE ON projects
WHEN NEW.code IS NOT OLD.code OR NEW.name IS NOT OLD.name OR
     NEW.client_id IS NOT OLD.client_id OR NEW.status IS NOT OLD.status OR
     NEW.manager IS NOT OLD.manager OR NEW.progress_bp IS NOT OLD.progress_bp
BEGIN
  INSERT INTO audit_logs(
    user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json
  )
  VALUES(
    (SELECT value FROM settings WHERE key='sync_email'),
    (SELECT value FROM settings WHERE key='device_id'),
    'UPDATE','project',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),
    json_object(
      'code',OLD.code,'name',OLD.name,'clientId',OLD.client_id,'status',OLD.status,
      'manager',OLD.manager,'progressBp',OLD.progress_bp
    ),
    json_object(
      'code',NEW.code,'name',NEW.name,'clientId',NEW.client_id,'status',NEW.status,
      'manager',NEW.manager,'progressBp',NEW.progress_bp
    )
  );
END;

CREATE TRIGGER audit_stage_insert AFTER INSERT ON project_stages
BEGIN
  INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
  VALUES(
    (SELECT value FROM settings WHERE key='sync_email'),
    (SELECT value FROM settings WHERE key='device_id'),
    'CREATE','project_stage',NEW.id,COALESCE(NEW.sync_uuid,(SELECT sync_uuid FROM project_stages WHERE id=NEW.id)),
    json_object(
      'projectId',NEW.project_id,'name',NEW.name,'sortOrder',NEW.sort_order,
      'startDate',NEW.start_date,'endDate',NEW.end_date,'status',NEW.status,
      'completionBp',NEW.completion_bp
    )
  );
END;

CREATE TRIGGER audit_stage_update AFTER UPDATE ON project_stages
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.name IS NOT OLD.name OR
     NEW.sort_order IS NOT OLD.sort_order OR NEW.start_date IS NOT OLD.start_date OR
     NEW.end_date IS NOT OLD.end_date OR NEW.status IS NOT OLD.status OR
     NEW.completion_bp IS NOT OLD.completion_bp
BEGIN
  INSERT INTO audit_logs(
    user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json
  )
  VALUES(
    (SELECT value FROM settings WHERE key='sync_email'),
    (SELECT value FROM settings WHERE key='device_id'),
    'UPDATE','project_stage',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),
    json_object(
      'projectId',OLD.project_id,'name',OLD.name,'sortOrder',OLD.sort_order,
      'startDate',OLD.start_date,'endDate',OLD.end_date,'status',OLD.status,
      'completionBp',OLD.completion_bp
    ),
    json_object(
      'projectId',NEW.project_id,'name',NEW.name,'sortOrder',NEW.sort_order,
      'startDate',NEW.start_date,'endDate',NEW.end_date,'status',NEW.status,
      'completionBp',NEW.completion_bp
    )
  );
END;

CREATE TRIGGER audit_stage_delete BEFORE DELETE ON project_stages
BEGIN
  INSERT INTO audit_logs(
    user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json
  )
  VALUES(
    (SELECT value FROM settings WHERE key='sync_email'),
    (SELECT value FROM settings WHERE key='device_id'),
    'DELETE','project_stage',OLD.id,OLD.sync_uuid,
    json_object(
      'projectId',OLD.project_id,'name',OLD.name,'sortOrder',OLD.sort_order,
      'startDate',OLD.start_date,'endDate',OLD.end_date,'status',OLD.status,
      'completionBp',OLD.completion_bp
    )
  );
END;

PRAGMA user_version = 24;
INSERT INTO app_metadata(key,value) VALUES('schema_version','24')
ON CONFLICT(key) DO UPDATE SET value='24';
INSERT INTO app_metadata(key,value) VALUES('application_version','0.6.7')
ON CONFLICT(key) DO UPDATE SET value='0.6.7';
