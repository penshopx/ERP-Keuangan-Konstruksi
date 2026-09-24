CREATE TABLE IF NOT EXISTS copilot_limits (
  scope text NOT NULL,
  scope_id text NOT NULL,
  daily_limit integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT copilot_limits_pk PRIMARY KEY (scope, scope_id),
  CONSTRAINT copilot_limits_scope_valid CHECK (scope IN ('role', 'project')),
  CONSTRAINT copilot_limits_daily_limit_valid CHECK (daily_limit BETWEEN 0 AND 100000)
);

CREATE TABLE IF NOT EXISTS copilot_usage (
  id text PRIMARY KEY,
  day date NOT NULL,
  role text NOT NULL,
  project_id text,
  tool text NOT NULL,
  status text NOT NULL,
  duration_ms integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT copilot_usage_status_valid CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED', 'TIMEOUT'))
);
CREATE INDEX IF NOT EXISTS copilot_usage_day_role_idx ON copilot_usage (day, role);
CREATE INDEX IF NOT EXISTS copilot_usage_day_project_idx ON copilot_usage (day, project_id);