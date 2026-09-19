CREATE TABLE IF NOT EXISTS invitation_reconciliation_state (
  key text PRIMARY KEY,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_failure_at timestamptz,
  last_success_at timestamptz,
  last_completed_at timestamptz,
  last_run_at timestamptz,
  last_run jsonb,
  monitoring_started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);