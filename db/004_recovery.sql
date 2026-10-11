ALTER TABLE step_run
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN retry_mode text NOT NULL DEFAULT 'automatic'
    CONSTRAINT step_run_retry_mode_check CHECK (retry_mode IN ('automatic', 'manual')),
  ADD COLUMN lookup_attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT step_run_lookup_attempt_count_check CHECK (lookup_attempt_count >= 0);
