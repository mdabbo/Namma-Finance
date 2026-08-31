-- Assignment lifecycle semantics (v0.7.0 milestone 2). Forward-only.
--
-- Archiving alone could not express whether work was finished or called off, so
-- an archived assignment kept contributing its full agreed fee to committed
-- cost and kept raising team-payment alerts. Lifecycle is now explicit and
-- SEPARATE from visibility:
--
--   lifecycle_status  ACTIVE | COMPLETED | CANCELLED   -- what happened to the work
--   archived_at       timestamp or NULL                -- whether it is still shown
--
-- ARCHIVED is deliberately not a lifecycle value. It is a visibility state, so
-- a completed assignment can be archived without losing the fact that its
-- unpaid earned value is still owed.
--
-- Financial treatment per lifecycle:
--   ACTIVE     unpaid earned value accrues; the full agreed fee is committed.
--   COMPLETED  unpaid earned value still accrues; the agreed fee stays
--              committed, because the scope is done and will be owed as the
--              client pays. No new scope is introduced.
--   CANCELLED  paid and earned history remain; the UNEARNED remainder of the
--              commitment is dropped. earned_minor_at_cancellation freezes the
--              earned figure so certificates the client pays afterwards cannot
--              accrue more to an assignment that was called off.

ALTER TABLE project_assignments ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE project_assignments ADD COLUMN completed_at TEXT;
ALTER TABLE project_assignments ADD COLUMN cancelled_at TEXT;
ALTER TABLE project_assignments ADD COLUMN cancellation_reason TEXT;
ALTER TABLE project_assignments ADD COLUMN earned_minor_at_cancellation INTEGER;

CREATE INDEX idx_assignments_lifecycle ON project_assignments(lifecycle_status);

-- Cancelling is an accounting event: without a date, a reason and the frozen
-- earned figure the remaining commitment could not be removed defensibly.
CREATE TRIGGER validate_assignment_lifecycle_insert
BEFORE INSERT ON project_assignments
BEGIN
  SELECT CASE
    WHEN NEW.lifecycle_status NOT IN ('ACTIVE','COMPLETED','CANCELLED')
      THEN RAISE(ABORT, 'INVALID_ASSIGNMENT_LIFECYCLE')
    WHEN NEW.lifecycle_status='CANCELLED' AND (
      NEW.cancelled_at IS NULL
      OR NEW.cancellation_reason IS NULL OR trim(NEW.cancellation_reason)=''
      OR NEW.earned_minor_at_cancellation IS NULL
    ) THEN RAISE(ABORT, 'CANCELLED_ASSIGNMENT_REQUIRES_EVIDENCE')
    WHEN NEW.lifecycle_status='COMPLETED' AND NEW.completed_at IS NULL
      THEN RAISE(ABORT, 'COMPLETED_ASSIGNMENT_REQUIRES_DATE')
    WHEN NEW.earned_minor_at_cancellation IS NOT NULL AND NEW.earned_minor_at_cancellation < 0
      THEN RAISE(ABORT, 'INVALID_EARNED_AT_CANCELLATION')
  END;
END;

CREATE TRIGGER validate_assignment_lifecycle_update
BEFORE UPDATE OF lifecycle_status, completed_at, cancelled_at, cancellation_reason, earned_minor_at_cancellation
ON project_assignments
BEGIN
  SELECT CASE
    WHEN NEW.lifecycle_status NOT IN ('ACTIVE','COMPLETED','CANCELLED')
      THEN RAISE(ABORT, 'INVALID_ASSIGNMENT_LIFECYCLE')
    WHEN NEW.lifecycle_status='CANCELLED' AND (
      NEW.cancelled_at IS NULL
      OR NEW.cancellation_reason IS NULL OR trim(NEW.cancellation_reason)=''
      OR NEW.earned_minor_at_cancellation IS NULL
    ) THEN RAISE(ABORT, 'CANCELLED_ASSIGNMENT_REQUIRES_EVIDENCE')
    WHEN NEW.lifecycle_status='COMPLETED' AND NEW.completed_at IS NULL
      THEN RAISE(ABORT, 'COMPLETED_ASSIGNMENT_REQUIRES_DATE')
    WHEN NEW.earned_minor_at_cancellation IS NOT NULL AND NEW.earned_minor_at_cancellation < 0
      THEN RAISE(ABORT, 'INVALID_EARNED_AT_CANCELLATION')
    -- A cancellation is a recorded fact, not an editable field.
    WHEN OLD.lifecycle_status='CANCELLED' AND NEW.lifecycle_status<>'CANCELLED'
      THEN RAISE(ABORT, 'CANCELLED_ASSIGNMENT_IS_FINAL')
  END;
END;

-- Lifecycle transitions are financial events and belong in the audit trail.
CREATE TRIGGER audit_assignment_lifecycle
AFTER UPDATE OF lifecycle_status ON project_assignments
WHEN NEW.lifecycle_status IS NOT OLD.lifecycle_status
BEGIN
  INSERT INTO audit_logs(
    user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason
  )
  VALUES(
    (SELECT value FROM settings WHERE key='sync_email'),
    (SELECT value FROM settings WHERE key='device_id'),
    'STATUS_CHANGE','project_assignment',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),
    json_object('lifecycleStatus',OLD.lifecycle_status),
    json_object(
      'lifecycleStatus',NEW.lifecycle_status,
      'completedAt',NEW.completed_at,
      'cancelledAt',NEW.cancelled_at,
      'earnedMinorAtCancellation',NEW.earned_minor_at_cancellation
    ),
    NEW.cancellation_reason
  );
END;

PRAGMA user_version = 25;
INSERT INTO app_metadata(key,value) VALUES('schema_version','25')
ON CONFLICT(key) DO UPDATE SET value='25';
