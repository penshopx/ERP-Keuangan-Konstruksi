ALTER TABLE petty_cash_policy_versions
  ADD COLUMN IF NOT EXISTS max_request_amount bigint NOT NULL DEFAULT 5000000,
  ADD COLUMN IF NOT EXISTS director_approval_above bigint NOT NULL DEFAULT 1000000;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'petty_cash_policy_thresholds_valid') THEN
    ALTER TABLE petty_cash_policy_versions
      ADD CONSTRAINT petty_cash_policy_thresholds_valid CHECK (max_request_amount > 0 AND director_approval_above >= 0 AND director_approval_above <= max_request_amount);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS petty_cash_funds (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  location text NOT NULL,
  custodian_user_id text NOT NULL,
  custodian_name text NOT NULL,
  book_balance bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT petty_cash_funds_balance_nonnegative CHECK (book_balance >= 0)
);
CREATE INDEX IF NOT EXISTS petty_cash_funds_project_idx ON petty_cash_funds(project_id);
CREATE TABLE IF NOT EXISTS petty_cash_fund_events (
  id text PRIMARY KEY,
  fund_id text NOT NULL REFERENCES petty_cash_funds(id) ON DELETE RESTRICT,
  request_id text,
  kind text NOT NULL,
  amount bigint NOT NULL,
  reference text NOT NULL,
  actor_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT petty_cash_fund_event_amount_positive CHECK (amount > 0)
);
ALTER TABLE petty_cash_requests
  ADD COLUMN IF NOT EXISTS fund_id text REFERENCES petty_cash_funds(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS verifier_user_id text,
  ADD COLUMN IF NOT EXISTS verifier_name text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS evaluator_user_id text,
  ADD COLUMN IF NOT EXISTS evaluator_name text,
  ADD COLUMN IF NOT EXISTS evaluation_note text,
  ADD COLUMN IF NOT EXISTS evaluated_at timestamptz;
ALTER TABLE petty_cash_requests DROP CONSTRAINT IF EXISTS petty_cash_requests_status_supported;
ALTER TABLE petty_cash_requests ADD CONSTRAINT petty_cash_requests_status_supported
  CHECK (status IN ('DIAJUKAN','DISETUJUI','DITOLAK','DICAIRKAN','DIPERTANGGUNGJAWABKAN','DIVERIFIKASI','DIREKONSILIASI','DIEVALUASI'));
ALTER TABLE petty_cash_expenses ALTER COLUMN receipt_reference DROP NOT NULL;
CREATE TABLE IF NOT EXISTS petty_cash_exceptions (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES petty_cash_requests(id) ON DELETE CASCADE,
  expense_id text NOT NULL REFERENCES petty_cash_expenses(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL,
  due_at date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);