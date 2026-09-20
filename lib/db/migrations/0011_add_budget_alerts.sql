CREATE TABLE IF NOT EXISTS budget_alert_thresholds (
  id text PRIMARY KEY,
  alert_type text NOT NULL CHECK (alert_type IN ('PROJECTED_EXPOSURE','ESTIMATE_AT_COMPLETION')),
  threshold_percent bigint NOT NULL CHECK (threshold_percent >= 0),
  effective_from date NOT NULL,
  effective_to date,
  owner text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS budget_alert_thresholds_effective_idx ON budget_alert_thresholds(alert_type, effective_from);
INSERT INTO budget_alert_thresholds (id, alert_type, threshold_percent, effective_from, owner)
VALUES
 ('budget-default-exposure-2026', 'PROJECTED_EXPOSURE', 90, '2026-01-01', 'PROJECT_MANAGER'),
 ('budget-default-eac-2026', 'ESTIMATE_AT_COMPLETION', 100, '2026-01-01', 'PROJECT_MANAGER')
ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS budget_alerts (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  baseline_id text,
  alert_type text NOT NULL CHECK (alert_type IN ('PROJECTED_EXPOSURE','ESTIMATE_AT_COMPLETION')),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  owner text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  title text NOT NULL,
  detail text NOT NULL,
  evidence jsonb NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP INDEX IF EXISTS budget_alert_active_dedupe_idx;
CREATE UNIQUE INDEX IF NOT EXISTS budget_alert_active_dedupe_idx
 ON budget_alerts(project_id, baseline_id, alert_type)
 WHERE status IN ('OPEN', 'ACKNOWLEDGED');