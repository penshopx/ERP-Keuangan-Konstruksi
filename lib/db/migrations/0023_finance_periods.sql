CREATE TABLE IF NOT EXISTS finance_accounts (
  code text PRIMARY KEY, name text NOT NULL, type text NOT NULL,
  cash_flow text, is_cash boolean NOT NULL DEFAULT false, active text NOT NULL DEFAULT 'YES',
  CONSTRAINT finance_account_type CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  CONSTRAINT finance_cash_flow CHECK (cash_flow IS NULL OR cash_flow IN ('OPERATING','INVESTING','FINANCING'))
);
CREATE TABLE IF NOT EXISTS finance_periods (
  month text PRIMARY KEY, status text NOT NULL DEFAULT 'OPEN',
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb, prepared_by text, approved_by text,
  reopen_reason text, reopen_requested_by text, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_period_status CHECK (status IN ('OPEN','REVIEW','CLOSED','REOPENED'))
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id text PRIMARY KEY, period text NOT NULL REFERENCES finance_periods(month),
  entry_date date NOT NULL, kind text NOT NULL DEFAULT 'NORMAL', cash_flow_category text,
  description text NOT NULL, source_type text, source_id text, reverses_id text,
  actor_user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_kind CHECK (kind IN ('NORMAL','ADJUSTMENT','REVERSAL')),
  CONSTRAINT journal_cash_flow_category CHECK (cash_flow_category IS NULL OR cash_flow_category IN ('OPERATING','INVESTING','FINANCING'))
);
CREATE UNIQUE INDEX IF NOT EXISTS journal_one_reversal ON journal_entries(reverses_id);
CREATE TABLE IF NOT EXISTS journal_lines (
  id text PRIMARY KEY, entry_id text NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  account_code text NOT NULL REFERENCES finance_accounts(code) ON DELETE RESTRICT,
  debit bigint NOT NULL DEFAULT 0, credit bigint NOT NULL DEFAULT 0,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT, wbs text, cost_code text,
  CONSTRAINT journal_positive_side CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE TABLE IF NOT EXISTS finance_report_versions (
  id text PRIMARY KEY, period text NOT NULL REFERENCES finance_periods(month),
  version integer NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(),
  approved_by text NOT NULL, report jsonb NOT NULL,
  CONSTRAINT finance_report_period_version UNIQUE (period, version)
);

CREATE OR REPLACE FUNCTION finance_guard_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Posted journals are immutable'; END IF;
  SELECT status INTO state FROM finance_periods WHERE month = NEW.period FOR UPDATE;
  IF state NOT IN ('OPEN','REOPENED') THEN RAISE EXCEPTION 'Financial period is locked'; END IF;
  IF to_char(NEW.entry_date, 'YYYY-MM') <> NEW.period THEN RAISE EXCEPTION 'Journal date is outside its period'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_entry_guard ON journal_entries;
CREATE TRIGGER finance_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION finance_guard_entry();

CREATE OR REPLACE FUNCTION finance_guard_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Posted journal lines are immutable'; END IF;
  -- Header row serializes lines with competing transactions.
  PERFORM 1 FROM journal_entries WHERE id = NEW.entry_id AND xmin::text = txid_current()::text FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lines can only be inserted with a new journal'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_line_guard ON journal_lines;
CREATE TRIGGER finance_line_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION finance_guard_line();

CREATE OR REPLACE FUNCTION finance_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO d,c
  FROM journal_lines WHERE entry_id = NEW.id;
  IF d = 0 OR d <> c THEN RAISE EXCEPTION 'Journal is not balanced'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS finance_entry_balance ON journal_entries;
CREATE CONSTRAINT TRIGGER finance_entry_balance AFTER INSERT ON journal_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance_check_balance();

CREATE OR REPLACE FUNCTION finance_guard_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_lines WHERE account_code = OLD.code) THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Used accounts cannot be deleted'; END IF;
    IF OLD.code <> NEW.code OR OLD.type <> NEW.type OR OLD.cash_flow IS DISTINCT FROM NEW.cash_flow OR OLD.is_cash <> NEW.is_cash THEN
      RAISE EXCEPTION 'Used account classification cannot change';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS finance_account_guard ON finance_accounts;
CREATE TRIGGER finance_account_guard BEFORE UPDATE OR DELETE ON finance_accounts
FOR EACH ROW EXECUTE FUNCTION finance_guard_account();

CREATE OR REPLACE FUNCTION finance_guard_issued() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Issued financial reports are immutable';
END $$;
DROP TRIGGER IF EXISTS finance_issued_guard ON finance_report_versions;
CREATE TRIGGER finance_issued_guard BEFORE UPDATE OR DELETE ON finance_report_versions
FOR EACH ROW EXECUTE FUNCTION finance_guard_issued();