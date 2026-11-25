-- Expense claims from the phone (plan step F6).
--
-- The phone files a claim (what was bought, how much, optionally a photo of the
-- receipt) straight into the cloud. The desktop pulls it here, and the office
-- ACCEPTS it -- which creates a numbered expense -- or REJECTS it with a
-- reason. A claim is never an expense: nothing here touches profit, numbering
-- or a report until a claim is accepted.
--
-- Design:
--   * Claims are created on the phone, never on the desktop, so every row
--     arrives through sync with its uuid. The desktop changes a claim in one
--     way only: recording the decision (accept_expense_claim_atomic /
--     reject_expense_claim_atomic in lib.rs).
--   * There is no status column. A claim with no decision is pending.
--   * A decided claim is evidence. Its expense was built from these exact
--     figures, so nothing it says may change afterwards. The cloud enforces the
--     same rule (docs/supabase-0025-expense-claims.sql).
--   * A claim withdrawn in the cloud is removed here by sync, as other
--     last-write-wins rows are. That never touches an expense already created
--     from it: the expense is its own record.
--   * The expense created from a claim carries the claim's uuid as its own
--     sync_uuid, so two desktops accepting the same claim make the same expense
--     record rather than two.

CREATE TABLE expense_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  supplier TEXT,
  receipt_storage_key TEXT,
  receipt_sha256 TEXT,
  submitted_at TEXT NOT NULL,
  decision TEXT CHECK (decision IN ('ACCEPTED', 'REJECTED')),
  decided_at TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  created_at TEXT,
  sync_uuid TEXT NOT NULL UNIQUE CHECK (length(sync_uuid) > 0),
  updated_at TEXT NOT NULL,
  CHECK ((receipt_storage_key IS NULL) = (receipt_sha256 IS NULL)),
  CHECK (
    (decision IS NULL AND decided_at IS NULL AND decided_by IS NULL AND decision_reason IS NULL)
    OR (decision IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CHECK (decision IS NOT 'REJECTED' OR length(trim(COALESCE(decision_reason, ''))) > 0)
);
CREATE INDEX idx_expense_claims_pending ON expense_claims(decision, submitted_at);
CREATE INDEX idx_expense_claims_updated ON expense_claims(updated_at, id);

-- A decided claim is evidence: only sync bookkeeping (updated_at) may change.
CREATE TRIGGER prevent_decided_expense_claim_update BEFORE UPDATE ON expense_claims
WHEN OLD.decision IS NOT NULL AND (
     NEW.id IS NOT OLD.id OR NEW.person_id IS NOT OLD.person_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.category_id IS NOT OLD.category_id OR NEW.date IS NOT OLD.date
  OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency
  OR NEW.description IS NOT OLD.description OR NEW.supplier IS NOT OLD.supplier
  OR NEW.receipt_storage_key IS NOT OLD.receipt_storage_key OR NEW.receipt_sha256 IS NOT OLD.receipt_sha256
  OR NEW.submitted_at IS NOT OLD.submitted_at OR NEW.decision IS NOT OLD.decision
  OR NEW.decided_at IS NOT OLD.decided_at OR NEW.decided_by IS NOT OLD.decided_by
  OR NEW.decision_reason IS NOT OLD.decision_reason OR NEW.created_at IS NOT OLD.created_at
  OR NEW.sync_uuid IS NOT OLD.sync_uuid)
BEGIN SELECT RAISE(ABORT, 'CLAIM_DECIDED_IMMUTABLE'); END;

-- Sync bookkeeping, as every synced table has: a change that leaves updated_at
-- alone gets a fresh one, and a removed row leaves a tombstone.
CREATE TRIGGER trg_expense_claims_sync_touch AFTER UPDATE ON expense_claims
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE expense_claims SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER trg_expense_claims_sync_tomb AFTER DELETE ON expense_claims
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('expense_claims', OLD.sync_uuid);
END;

PRAGMA user_version = 32;
INSERT INTO app_metadata(key,value) VALUES('schema_version','32')
ON CONFLICT(key) DO UPDATE SET value='32';
