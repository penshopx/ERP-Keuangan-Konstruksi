ALTER TABLE commitment_lines ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;
ALTER TABLE commitment_lines ADD COLUMN IF NOT EXISTS tax_basis_points integer NOT NULL DEFAULT 0;
ALTER TABLE commitment_lines ADD COLUMN IF NOT EXISTS retention_basis_points integer NOT NULL DEFAULT 0;
ALTER TABLE actual_cost_allocations DROP CONSTRAINT IF EXISTS actual_cost_allocations_amount_nonnegative;
ALTER TABLE actual_cost_allocations ADD CONSTRAINT actual_cost_allocations_amount_nonnegative CHECK (amount >= 0 OR source_type IN ('VENDOR_CREDIT', 'VENDOR_CANCEL'));
CREATE TABLE IF NOT EXISTS vendor_match_policies (
  id text PRIMARY KEY, version integer NOT NULL UNIQUE, effective_from timestamptz NOT NULL,
  quantity_tolerance_basis_points integer NOT NULL, price_tolerance_basis_points integer NOT NULL,
  tax_tolerance bigint NOT NULL, retention_tolerance bigint NOT NULL, total_tolerance bigint NOT NULL,
  CONSTRAINT vendor_match_policy_valid CHECK (quantity_tolerance_basis_points BETWEEN 0 AND 10000 AND price_tolerance_basis_points BETWEEN 0 AND 10000 AND tax_tolerance >= 0 AND retention_tolerance >= 0 AND total_tolerance >= 0)
);
INSERT INTO vendor_match_policies VALUES ('initial-v1', 1, '2000-01-01T00:00:00Z', 0, 0, 0, 0, 0)
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS vendor_invoices (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  commitment_id text NOT NULL REFERENCES commitments(id) ON DELETE RESTRICT,
  line_id text NOT NULL REFERENCES commitment_lines(id) ON DELETE RESTRICT,
  cost_code_id text NOT NULL REFERENCES project_cost_codes(id) ON DELETE RESTRICT,
  vendor_key text NOT NULL, invoice_number text NOT NULL, kind text NOT NULL DEFAULT 'INVOICE',
  original_invoice_id text, quantity integer NOT NULL, unit_price bigint NOT NULL,
  tax bigint NOT NULL, retention bigint NOT NULL, total bigint NOT NULL,
  receipt_event_ids jsonb NOT NULL, evidence text NOT NULL, status text NOT NULL DEFAULT 'EXCEPTION',
  exceptions jsonb NOT NULL DEFAULT '[]', policy_version integer NOT NULL,
  policy_snapshot jsonb NOT NULL, eligible_amount bigint NOT NULL DEFAULT 0,
  maker_id text NOT NULL, reviewer_id text, review_evidence text, reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_invoice_number_unique UNIQUE (vendor_key, invoice_number),
  CONSTRAINT vendor_invoice_values_valid CHECK (quantity > 0 AND unit_price >= 0 AND tax >= 0 AND retention >= 0 AND total >= 0)
);
CREATE TABLE IF NOT EXISTS vendor_payments (
  id text PRIMARY KEY, invoice_id text NOT NULL REFERENCES vendor_invoices(id) ON DELETE RESTRICT,
  amount bigint NOT NULL CHECK (amount > 0), status text NOT NULL DEFAULT 'REQUESTED',
  maker_id text NOT NULL, approver_id text, releaser_id text,
  evidence text NOT NULL, approval_evidence text, release_evidence text,
  created_at timestamptz NOT NULL DEFAULT now()
);