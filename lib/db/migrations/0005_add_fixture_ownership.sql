ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "fixture_owner" text;

ALTER TABLE "tax_calculation_snapshots"
  ADD COLUMN IF NOT EXISTS "fixture_owner" text;