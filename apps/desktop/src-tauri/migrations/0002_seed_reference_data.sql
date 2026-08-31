-- NAMAA Finance reference data (v0.7.0 database rebase, Milestone 7).
-- Exactly the rows the old migration chain seeded, plus version metadata.

-- ── currencies ──
INSERT INTO currencies (code,fx_rate_micro) VALUES ('EGP',1000000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('USD',48500000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('EUR',52500000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('GBP',61500000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('SAR',12900000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('AED',13200000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('QAR',13300000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('KWD',158000000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('BHD',128500000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('OMR',126000000);
INSERT INTO currencies (code,fx_rate_micro) VALUES ('JOD',68400000);

-- ── audit_context ──
INSERT INTO audit_context (id,source,application_version) VALUES (1,'DESKTOP','0.6.3');

-- ── app_metadata ──
INSERT INTO app_metadata (key,value) VALUES ('application_id','com.mepfinance.app');
INSERT INTO app_metadata (key,value) VALUES ('application_version','0.7.0');
INSERT INTO app_metadata (key,value) VALUES ('schema_version','24');

PRAGMA user_version = 24;
