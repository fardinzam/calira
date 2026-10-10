ALTER TABLE run
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN error_code text,
  ADD COLUMN error_message text,
  ADD CONSTRAINT run_state_check CHECK (state IN ('queued', 'running', 'filtered_out', 'succeeded', 'failed', 'partially_failed'));

CREATE TABLE step_run (
  run_id uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  step_name text NOT NULL CHECK (step_name IN ('filter', 'calendar', 'gmail')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'skipped', 'failed', 'uncertain')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_message text,
  result_summary text,
  external_id text,
  PRIMARY KEY (run_id, step_name)
);
