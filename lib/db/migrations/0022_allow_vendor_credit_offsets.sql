ALTER TABLE actual_cost_allocations DROP CONSTRAINT IF EXISTS actual_cost_allocations_amount_check;
ALTER TABLE actual_cost_allocations DROP CONSTRAINT IF EXISTS actual_cost_allocations_amount_nonnegative;
ALTER TABLE actual_cost_allocations ADD CONSTRAINT actual_cost_allocations_amount_nonnegative
  CHECK (amount >= 0 OR source_type IN ('VENDOR_CREDIT', 'VENDOR_CANCEL'));