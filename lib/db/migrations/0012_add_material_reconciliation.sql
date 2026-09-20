CREATE TABLE IF NOT EXISTS materials (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  base_unit text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rab_material_requirements (
  id text PRIMARY KEY,
  baseline_id text NOT NULL REFERENCES rab_baselines(id) ON DELETE CASCADE,
  rab_item_id text NOT NULL REFERENCES rab_items(id) ON DELETE CASCADE,
  cost_code_id text NOT NULL REFERENCES project_cost_codes(id) ON DELETE RESTRICT,
  material_id text NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
  analysis_version integer NOT NULL,
  coefficient_micros bigint NOT NULL CHECK (coefficient_micros > 0),
  unit text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rab_material_requirement_version_idx UNIQUE (baseline_id, rab_item_id, material_id, analysis_version)
);

CREATE TABLE IF NOT EXISTS material_waste_tolerance_versions (
  id text PRIMARY KEY,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  cost_code_id text REFERENCES project_cost_codes(id) ON DELETE CASCADE,
  material_id text REFERENCES materials(id) ON DELETE CASCADE,
  work_category text,
  tolerance_basis_points integer NOT NULL CHECK (tolerance_basis_points BETWEEN 0 AND 10000),
  effective_from date NOT NULL,
  effective_to date,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS material_waste_tolerance_lookup_idx ON material_waste_tolerance_versions(project_id, cost_code_id, material_id, effective_from);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  baseline_id text NOT NULL REFERENCES rab_baselines(id) ON DELETE RESTRICT,
  cost_code_id text NOT NULL REFERENCES project_cost_codes(id) ON DELETE RESTRICT,
  material_id text NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
  movement_type text NOT NULL CHECK (movement_type IN ('PROCURED','RECEIVED','ISSUED','RETURNED','INSTALLED','INVOICED','ACTUAL_COST','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT')),
  quantity_micros bigint NOT NULL CHECK (quantity_micros >= 0),
  unit text NOT NULL,
  base_quantity_micros bigint NOT NULL CHECK (base_quantity_micros >= 0),
  source_document_type text NOT NULL,
  source_document_id text NOT NULL,
  source_document_number text NOT NULL,
  occurred_at timestamptz NOT NULL,
  notes text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movement_source_idx UNIQUE (source_document_type, source_document_id, movement_type, material_id, cost_code_id)
);
CREATE INDEX IF NOT EXISTS inventory_movement_reconciliation_idx ON inventory_movements(project_id, baseline_id, cost_code_id, material_id);

CREATE TABLE IF NOT EXISTS material_variance_exceptions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  baseline_id text NOT NULL REFERENCES rab_baselines(id) ON DELETE RESTRICT,
  cost_code_id text NOT NULL REFERENCES project_cost_codes(id) ON DELETE RESTRICT,
  rab_item_id text NOT NULL REFERENCES rab_items(id) ON DELETE RESTRICT,
  material_id text NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
  tolerance_version_id text REFERENCES material_waste_tolerance_versions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UNDER_REVIEW','CLOSED')),
  classification text CHECK (classification IS NULL OR classification IN ('WASTE','DESIGN_CHANGE','REWORK','MISALLOCATION','RECORDING_DELAY','IN_TRANSIT','UNIT_CONVERSION','DAMAGE','LOSS')),
  disposition text,
  theoretical_quantity_micros bigint NOT NULL,
  consumed_quantity_micros bigint NOT NULL,
  variance_quantity_micros bigint NOT NULL,
  tolerance_quantity_micros bigint NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  closed_by text,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_variance_exception_open_idx UNIQUE (project_id, baseline_id, cost_code_id, material_id)
);

CREATE TABLE IF NOT EXISTS material_variance_events (
  id text PRIMARY KEY,
  exception_id text NOT NULL REFERENCES material_variance_exceptions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_user_id text NOT NULL,
  actor_name text NOT NULL,
  detail text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);