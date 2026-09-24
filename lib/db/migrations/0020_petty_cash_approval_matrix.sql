ALTER TABLE petty_cash_policy_versions
  ADD COLUMN IF NOT EXISTS standard_approver_role text NOT NULL DEFAULT 'PROJECT_MANAGER',
  ADD COLUMN IF NOT EXISTS high_approver_role text NOT NULL DEFAULT 'DIRECTOR';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'petty_cash_policy_roles_valid') THEN
    ALTER TABLE petty_cash_policy_versions ADD CONSTRAINT petty_cash_policy_roles_valid
      CHECK (standard_approver_role IN ('PROJECT_MANAGER','FINANCE','DIRECTOR')
        AND high_approver_role IN ('PROJECT_MANAGER','FINANCE','DIRECTOR'));
  END IF;
END $$;