-- Mark deliberate team-member payments that may exceed currently earned due.
--
-- Normal EARNED payments keep the lifecycle-aware due ceiling. SPECIAL payments
-- are still posted as linked expenses, but the marker keeps sync/domain checks
-- from treating them as accidental overpayments.

ALTER TABLE person_payments
  ADD COLUMN payment_kind TEXT NOT NULL DEFAULT 'EARNED'
  CHECK(payment_kind IN ('EARNED','SPECIAL'));

UPDATE audit_context SET application_version = '0.7.1' WHERE id = 1;
INSERT INTO app_metadata(key,value) VALUES('application_version','0.7.1')
ON CONFLICT(key) DO UPDATE SET value='0.7.1';

PRAGMA user_version = 29;
INSERT INTO app_metadata(key,value) VALUES('schema_version','29')
ON CONFLICT(key) DO UPDATE SET value='29';
