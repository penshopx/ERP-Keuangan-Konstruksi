CREATE TABLE IF NOT EXISTS operational_alert_delivery_status (
  source text PRIMARY KEY,
  last_attempt_at timestamptz NOT NULL,
  last_result text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operational_alert_delivery_result_supported
    CHECK (last_result IN ('DELIVERED', 'NOT_CONFIGURED', 'DELIVERY_FAILED'))
);