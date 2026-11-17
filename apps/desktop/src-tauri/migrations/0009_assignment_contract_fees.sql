-- Optional fee per contract on a team assignment.
--
-- An assignment normally has one agreed fee split across every stage of the
-- project's contracts by value share, which yields uneven cents when the
-- contracts differ in size. contract_fees lets the fee be fixed PER CONTRACT:
-- JSON {"<contract number>": <fee in minor units>}. NULL keeps the original
-- single-fee behaviour, so every existing assignment is unchanged.
--
-- Keyed by contract NUMBER, not id: local ids differ between devices, numbers
-- travel through sync unchanged. The rule itself lives in @mep/core
-- (allocateStageAmounts) and is mirrored in lib.rs (allocate_stage_amounts).

ALTER TABLE project_assignments ADD COLUMN contract_fees TEXT
  CHECK (contract_fees IS NULL OR json_valid(contract_fees));

PRAGMA user_version = 31;
INSERT INTO app_metadata(key,value) VALUES('schema_version','31')
ON CONFLICT(key) DO UPDATE SET value='31';
