CREATE OR REPLACE FUNCTION finance_guard_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Posted journals are immutable'; END IF;
  -- One transaction-scoped lock serializes every journal insertion with every report issuance.
  -- Take it before locking an individual period to avoid cross-period deadlocks.
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-ledger-issuance', 0));
  SELECT status INTO state FROM finance_periods WHERE month = NEW.period FOR UPDATE;
  IF state NOT IN ('OPEN','REOPENED') THEN RAISE EXCEPTION 'Financial period is locked'; END IF;
  IF to_char(NEW.entry_date, 'YYYY-MM') <> NEW.period THEN RAISE EXCEPTION 'Journal date is outside its period'; END IF;
  IF EXISTS (SELECT 1 FROM finance_report_versions WHERE period > NEW.period) THEN
    RAISE EXCEPTION 'A later period has already been issued; post an adjustment in an allowed later period';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finance_guard_report_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-ledger-issuance', 0));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_report_insert_guard ON finance_report_versions;
CREATE TRIGGER finance_report_insert_guard BEFORE INSERT ON finance_report_versions
FOR EACH ROW EXECUTE FUNCTION finance_guard_report_insert();