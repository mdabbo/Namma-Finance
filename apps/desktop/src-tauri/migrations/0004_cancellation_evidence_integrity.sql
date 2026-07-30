-- Cancellation evidence integrity (v0.7.0 milestone 2/3 audit). Forward-only.
--
-- Audit finding: earned_minor_at_cancellation is the frozen figure that decides
-- a cancelled assignment's committed cost AND the balance still owed to the
-- person. Migration 0003 required it to be present, but nothing stopped it from
-- being changed afterwards:
--
--   * validate_assignment_lifecycle_update permitted an UPDATE that altered the
--     frozen amount as long as lifecycle_status itself did not change;
--   * audit_assignment_lifecycle fires only when lifecycle_status changes;
--   * the baseline audit_assignment_update watches person/project/agreed/
--     currency/fx/archived_at only.
--
-- So `UPDATE project_assignments SET earned_minor_at_cancellation=<anything>`
-- silently rewrote a financial fact with NO audit row at all (reproduced
-- against this schema before the fix).
--
-- Two rules close it, both additive so migration 0003 stays untouched:
--   1. The frozen figure only exists on a cancelled assignment.
--   2. Once cancelled, the cancellation evidence is final.
--
-- Because every legitimate write of these columns therefore happens on the
-- transition into CANCELLED, the existing audit_assignment_lifecycle trigger
-- now necessarily captures every change to them — no audit gap remains.

-- Rule 1: a frozen earned figure is meaningless unless the work was called off,
-- so it may not be parked on an ACTIVE or COMPLETED assignment.
CREATE TRIGGER validate_frozen_earned_requires_cancellation_insert
BEFORE INSERT ON project_assignments
WHEN NEW.lifecycle_status <> 'CANCELLED' AND NEW.earned_minor_at_cancellation IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'FROZEN_EARNED_REQUIRES_CANCELLATION');
END;

-- Reverting an already-cancelled assignment is deliberately left to migration
-- 0003's CANCELLED_ASSIGNMENT_IS_FINAL, which names the real problem; this
-- trigger only guards parking a frozen figure on work that is still live.
CREATE TRIGGER validate_frozen_earned_requires_cancellation_update
BEFORE UPDATE OF lifecycle_status, earned_minor_at_cancellation ON project_assignments
WHEN OLD.lifecycle_status <> 'CANCELLED'
  AND NEW.lifecycle_status <> 'CANCELLED'
  AND NEW.earned_minor_at_cancellation IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'FROZEN_EARNED_REQUIRES_CANCELLATION');
END;

-- Rule 2: cancellation evidence is a recorded accounting fact. Correcting it
-- would rewrite committed cost and the amount owed with no trace, so it is
-- refused outright rather than audited after the fact.
CREATE TRIGGER validate_cancellation_evidence_final
BEFORE UPDATE OF cancelled_at, cancellation_reason, earned_minor_at_cancellation
ON project_assignments
WHEN OLD.lifecycle_status = 'CANCELLED'
BEGIN
  SELECT CASE
    WHEN NEW.earned_minor_at_cancellation IS NOT OLD.earned_minor_at_cancellation
      OR NEW.cancelled_at IS NOT OLD.cancelled_at
      OR NEW.cancellation_reason IS NOT OLD.cancellation_reason
    THEN RAISE(ABORT, 'CANCELLATION_EVIDENCE_IS_FINAL')
  END;
END;

PRAGMA user_version = 26;
INSERT INTO app_metadata(key,value) VALUES('schema_version','26')
ON CONFLICT(key) DO UPDATE SET value='26';
