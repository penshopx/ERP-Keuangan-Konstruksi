CREATE TABLE IF NOT EXISTS competency_catalog (
  id text PRIMARY KEY,
  scheme_code text NOT NULL,
  scheme_type text NOT NULL,
  occupation text NOT NULL,
  title text NOT NULL,
  level integer NOT NULL CHECK (level BETWEEN 1 AND 9),
  source_url text NOT NULL,
  validity_status text NOT NULL DEFAULT 'REFERENCE_ONLY',
  effective_from date,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competency_catalog_entry_idx UNIQUE (scheme_code, title, level)
);
CREATE TABLE IF NOT EXISTS user_competency_profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  catalog_entry_id text NOT NULL REFERENCES competency_catalog(id) ON DELETE RESTRICT,
  verification_status text NOT NULL DEFAULT 'UNVERIFIED',
  certificate_reference text,
  effective_from date,
  expires_at date,
  verified_by text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_competency_profile_entry_idx UNIQUE (user_id, catalog_entry_id)
);
CREATE TABLE IF NOT EXISTS ahs_templates (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  source_note text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ahs_template_code_version_idx UNIQUE (code, version)
);
CREATE TABLE IF NOT EXISTS ahs_components (
  id text PRIMARY KEY,
  template_id text NOT NULL REFERENCES ahs_templates(id) ON DELETE CASCADE,
  resource_kind text NOT NULL CHECK (resource_kind IN ('MATERIAL','LABOR','EQUIPMENT')),
  resource_code text NOT NULL,
  resource_name text NOT NULL,
  unit text NOT NULL,
  coefficient_micros bigint NOT NULL CHECK (coefficient_micros > 0),
  waste_basis_points integer NOT NULL DEFAULT 0 CHECK (waste_basis_points BETWEEN 0 AND 10000)
);
CREATE TABLE IF NOT EXISTS resource_prices (
  id text PRIMARY KEY,
  resource_kind text NOT NULL CHECK (resource_kind IN ('MATERIAL','LABOR','EQUIPMENT')),
  resource_code text NOT NULL,
  unit text NOT NULL,
  unit_price_rupiah bigint NOT NULL CHECK (unit_price_rupiah >= 0),
  effective_from date NOT NULL,
  effective_to date,
  source_note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_price_period_idx UNIQUE (resource_kind, resource_code, effective_from)
);
CREATE TABLE IF NOT EXISTS estimate_previews (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_id text NOT NULL REFERENCES ahs_templates(id) ON DELETE RESTRICT,
  effective_date date NOT NULL,
  volume_basis_points integer NOT NULL CHECK (volume_basis_points > 0),
  unit_price_rupiah bigint NOT NULL CHECK (unit_price_rupiah >= 0),
  total_budget_rupiah bigint NOT NULL CHECK (total_budget_rupiah >= 0),
  formula_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PREVIEW',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rab_estimate_snapshots (
  id text PRIMARY KEY,
  baseline_id text NOT NULL REFERENCES rab_baselines(id) ON DELETE CASCADE,
  preview_id text NOT NULL REFERENCES estimate_previews(id) ON DELETE RESTRICT,
  formula_snapshot jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO competency_catalog (id, scheme_code, scheme_type, occupation, title, level, source_url, validity_status)
VALUES
 ('skkk-038-2022-jhk-4', 'SKKK 038-2022', 'SKKK', 'Juru Hitung Kuantitas', 'Juru Hitung Kuantitas Muda', 4, 'https://skkni.kemnaker.go.id/tentang-skkk-skki/dokumen?limit=20&page=1&title=juru%20hitung%20kuantitas', 'REFERENCE_ONLY'),
 ('skkk-038-2022-jhk-5', 'SKKK 038-2022', 'SKKK', 'Juru Hitung Kuantitas', 'Juru Hitung Kuantitas Madya', 5, 'https://skkni.kemnaker.go.id/tentang-skkk-skki/dokumen?limit=20&page=1&title=juru%20hitung%20kuantitas', 'REFERENCE_ONLY'),
 ('skkk-038-2022-jhk-6', 'SKKK 038-2022', 'SKKK', 'Juru Hitung Kuantitas', 'Juru Hitung Kuantitas Utama', 6, 'https://skkni.kemnaker.go.id/tentang-skkk-skki/dokumen?limit=20&page=1&title=juru%20hitung%20kuantitas', 'REFERENCE_ONLY'),
 ('skkni-385-2013-ebj-5', 'SKKNI 385-2013', 'SKKNI', 'Estimator Biaya Jalan', 'Estimator Biaya Jalan Madya', 5, 'https://skkni-api.kemnaker.go.id/v1/public/documents/f3f393bc-00d9-43d9-a6f5-17df2b92d4e9/download', 'REFERENCE_ONLY'),
 ('skkni-385-2013-ebj-6', 'SKKNI 385-2013', 'SKKNI', 'Estimator Biaya Jalan', 'Estimator Biaya Jalan Utama', 6, 'https://skkni-api.kemnaker.go.id/v1/public/documents/f3f393bc-00d9-43d9-a6f5-17df2b92d4e9/download', 'REFERENCE_ONLY'),
 ('skkni-06-2011-qs-5', 'SKKNI 06-2011', 'SKKNI', 'Quantity Surveyor', 'Quantity Surveyor Madya', 5, 'https://skkni-api.kemnaker.go.id/v1/public/documents/5f16bf68-2cb3-42d8-b60b-4dc4ae3054c1/download', 'REFERENCE_ONLY'),
 ('skkni-06-2011-qs-6', 'SKKNI 06-2011', 'SKKNI', 'Quantity Surveyor', 'Quantity Surveyor Utama', 6, 'https://skkni-api.kemnaker.go.id/v1/public/documents/5f16bf68-2cb3-42d8-b60b-4dc4ae3054c1/download', 'REFERENCE_ONLY'),
 ('skkni-06-2011-aqs-7', 'SKKNI 06-2011', 'SKKNI', 'Ahli Quantity Surveyor', 'Ahli Muda Quantity Surveyor', 7, 'https://skkni-api.kemnaker.go.id/v1/public/documents/5f16bf68-2cb3-42d8-b60b-4dc4ae3054c1/download', 'REFERENCE_ONLY'),
 ('skkni-06-2011-aqs-8', 'SKKNI 06-2011', 'SKKNI', 'Ahli Quantity Surveyor', 'Ahli Madya Quantity Surveyor', 8, 'https://skkni-api.kemnaker.go.id/v1/public/documents/5f16bf68-2cb3-42d8-b60b-4dc4ae3054c1/download', 'REFERENCE_ONLY'),
 ('skkni-06-2011-aqs-9', 'SKKNI 06-2011', 'SKKNI', 'Ahli Quantity Surveyor', 'Ahli Utama Quantity Surveyor', 9, 'https://skkni-api.kemnaker.go.id/v1/public/documents/5f16bf68-2cb3-42d8-b60b-4dc4ae3054c1/download', 'REFERENCE_ONLY')
ON CONFLICT DO NOTHING;