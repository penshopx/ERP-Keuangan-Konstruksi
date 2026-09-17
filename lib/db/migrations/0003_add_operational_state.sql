CREATE TABLE IF NOT EXISTS operational_state (
  key text PRIMARY KEY,
  last_successful_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);