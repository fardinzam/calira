ALTER TABLE workflow ADD COLUMN config_json jsonb;
ALTER TABLE run ADD COLUMN config_snapshot jsonb;

-- Existing Milestone 01 workflows have no complete configuration.
UPDATE workflow SET enabled = false WHERE config_json IS NULL;
