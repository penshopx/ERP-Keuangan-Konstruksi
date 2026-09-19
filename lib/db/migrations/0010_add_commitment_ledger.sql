CREATE TABLE IF NOT EXISTS project_cost_codes (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_cost_codes_project_code_unique UNIQUE (project_id, code)
);
INSERT INTO project_cost_codes (id, project_id, code, name)
SELECT p.project_id || ':' || rb.code, p.project_id, rb.code, rb.name
FROM rab_items rb JOIN rab_baselines p ON p.id = rb.baseline_id
ON CONFLICT DO NOTHING;
ALTER TABLE rab_items ADD COLUMN IF NOT EXISTS cost_code_id text;
UPDATE rab_items rb SET cost_code_id = cc.id
FROM project_cost_codes cc JOIN rab_baselines b ON b.project_id = cc.project_id
WHERE rb.baseline_id = b.id AND rb.code = cc.code AND rb.cost_code_id IS NULL;

CREATE TABLE IF NOT EXISTS commitments (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  baseline_id text NOT NULL REFERENCES rab_baselines(id) ON DELETE RESTRICT,
  document_type text NOT NULL CHECK (document_type IN ('PO','SPK','SUBKON')),
  document_number text NOT NULL,
  vendor_name text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED','CLOSED')),
  version integer NOT NULL DEFAULT 1,
  total_amount bigint NOT NULL CHECK (total_amount >= 0),
  approved_by text,
  approved_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, document_number, version)
);
CREATE TABLE IF NOT EXISTS commitment_lines (
  id text PRIMARY KEY,
  commitment_id text NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  cost_code_id text NOT NULL REFERENCES project_cost_codes(id) ON DELETE RESTRICT,
  rab_item_id text REFERENCES rab_items(id) ON DELETE RESTRICT,
  description text NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 0),
  received_amount bigint NOT NULL DEFAULT 0,
  invoiced_amount bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commitment_events (
  id text PRIMARY KEY,
  commitment_id text NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  amount bigint NOT NULL DEFAULT 0,
  metadata text NOT NULL DEFAULT '{}',
  actor_user_id text NOT NULL,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS commitment_events_source_idx ON commitment_events(commitment_id, event_type, source_id);
CREATE TABLE IF NOT EXISTS actual_cost_allocations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  baseline_id text NOT NULL REFERENCES rab_baselines(id) ON DELETE RESTRICT,
  cost_code_id text NOT NULL REFERENCES project_cost_codes(id) ON DELETE RESTRICT,
  commitment_id text REFERENCES commitments(id) ON DELETE RESTRICT,
  source_type text NOT NULL,
  source_id text NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, cost_code_id)
);
CREATE INDEX IF NOT EXISTS commitments_project_status_idx ON commitments(project_id, status);