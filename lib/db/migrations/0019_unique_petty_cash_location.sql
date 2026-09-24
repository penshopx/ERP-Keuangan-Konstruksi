CREATE UNIQUE INDEX IF NOT EXISTS petty_cash_funds_project_location_idx
  ON petty_cash_funds(project_id, location);