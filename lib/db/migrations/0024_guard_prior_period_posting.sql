CREATE OR REPLACE FUNCTION finance_guard_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Posted journals are immutable'; END IF;
  SELECT status INTO state FROM finance_periods WHERE month = NEW.period FOR UPDATE;
  IF state NOT IN ('OPEN','REOPENED') THEN RAISE EXCEPTION 'Financial period is locked'; END IF;
  IF to_char(NEW.entry_date, 'YYYY-MM') <> NEW.period THEN RAISE EXCEPTION 'Journal date is outside its period'; END IF;
  IF EXISTS (SELECT 1 FROM finance_report_versions WHERE period > NEW.period) THEN
    RAISE EXCEPTION 'A later period has already been issued; post an adjustment in an allowed later period';
  END IF;
  RETURN NEW;
END $$;