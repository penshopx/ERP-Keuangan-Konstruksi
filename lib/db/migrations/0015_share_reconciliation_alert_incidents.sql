ALTER TABLE invitation_reconciliation_state
  ADD COLUMN IF NOT EXISTS alert_incident_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alert_incident_reason text,
  ADD COLUMN IF NOT EXISTS degraded_alert_sent boolean NOT NULL DEFAULT false;

ALTER TABLE invitation_reconciliation_state
  DROP CONSTRAINT IF EXISTS invitation_reconciliation_alert_reason_supported;

ALTER TABLE invitation_reconciliation_state
  ADD CONSTRAINT invitation_reconciliation_alert_reason_supported
  CHECK (
    alert_incident_reason IS NULL
    OR alert_incident_reason IN ('CONSECUTIVE_FAILURES', 'NO_RECENT_COMPLETION')
  );