ALTER TABLE step_run
  ADD COLUMN uncertain_send_seen boolean NOT NULL DEFAULT false;

UPDATE step_run
SET uncertain_send_seen = true
WHERE step_name = 'gmail' AND state = 'uncertain';
