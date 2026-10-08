CREATE TABLE workflow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  form_id text NOT NULL CHECK (length(btrim(form_id)) > 0),
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE form_poll_state (
  workflow_id uuid PRIMARY KEY REFERENCES workflow(id) ON DELETE CASCADE,
  cursor_at timestamptz,
  last_checked_at timestamptz,
  last_error text
);

CREATE TABLE run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  response_id text NOT NULL,
  create_time timestamptz NOT NULL,
  last_submitted_time timestamptz NOT NULL,
  answers_json jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, response_id)
);

CREATE INDEX run_created_at_idx ON run (created_at DESC);
