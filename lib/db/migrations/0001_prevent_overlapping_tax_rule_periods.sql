CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Preserve the behavior of a bounded override inside an older open-ended rule
-- by creating a continuation segment after the override ends.
WITH bounded_overrides AS (
  SELECT DISTINCT ON (predecessor.id)
    predecessor.*,
    successor.effective_to AS override_effective_to
  FROM tax_rule_versions AS predecessor
  JOIN tax_rule_versions AS successor
    ON successor.service_type = predecessor.service_type
    AND successor.qualification IS NOT DISTINCT FROM predecessor.qualification
    AND successor.requires_sbu = predecessor.requires_sbu
    AND successor.supplier_pkp = predecessor.supplier_pkp
    AND successor.government_collector = predecessor.government_collector
    AND successor.integrated = predecessor.integrated
    AND successor.effective_from > predecessor.effective_from
  WHERE predecessor.effective_to IS NULL
    AND successor.effective_to IS NOT NULL
  ORDER BY predecessor.id, successor.effective_to DESC
)
INSERT INTO tax_rule_versions (
  id,
  version,
  effective_from,
  effective_to,
  regulatory_source,
  service_type,
  qualification,
  requires_sbu,
  supplier_pkp,
  government_collector,
  integrated,
  dpp_rate_basis_points,
  ppn_rate_basis_points,
  pph_final_rate_basis_points,
  pph_23_rate_basis_points,
  created_at
)
SELECT
  id || '-continuation-' || (override_effective_to + 1)::text,
  version || '-CONT-' || (override_effective_to + 1)::text,
  override_effective_to + 1,
  NULL,
  regulatory_source,
  service_type,
  qualification,
  requires_sbu,
  supplier_pkp,
  government_collector,
  integrated,
  dpp_rate_basis_points,
  ppn_rate_basis_points,
  pph_final_rate_basis_points,
  pph_23_rate_basis_points,
  created_at
FROM bounded_overrides;

-- Existing open-ended rules predate API overlap checks. Close a predecessor
-- immediately before the first later rule with identical criteria.
WITH successors AS (
  SELECT
    predecessor.id,
    MIN(successor.effective_from) - 1 AS effective_to
  FROM tax_rule_versions AS predecessor
  JOIN tax_rule_versions AS successor
    ON successor.service_type = predecessor.service_type
    AND successor.qualification IS NOT DISTINCT FROM predecessor.qualification
    AND successor.requires_sbu = predecessor.requires_sbu
    AND successor.supplier_pkp = predecessor.supplier_pkp
    AND successor.government_collector = predecessor.government_collector
    AND successor.integrated = predecessor.integrated
    AND successor.effective_from > predecessor.effective_from
  WHERE predecessor.effective_to IS NULL
  GROUP BY predecessor.id
)
UPDATE tax_rule_versions AS rule
SET effective_to = successors.effective_to
FROM successors
WHERE rule.id = successors.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tax_rule_versions_valid_period'
      AND conrelid = 'tax_rule_versions'::regclass
  ) THEN
    ALTER TABLE tax_rule_versions
      ADD CONSTRAINT tax_rule_versions_valid_period
      CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tax_rule_versions_no_overlapping_periods'
      AND conrelid = 'tax_rule_versions'::regclass
  ) THEN
    ALTER TABLE tax_rule_versions
      ADD CONSTRAINT tax_rule_versions_no_overlapping_periods
      EXCLUDE USING gist (
        service_type WITH =,
        COALESCE(qualification, '') WITH =,
        requires_sbu WITH =,
        supplier_pkp WITH =,
        government_collector WITH =,
        integrated WITH =,
        daterange(
          effective_from,
          COALESCE(effective_to + 1, 'infinity'::date),
          '[)'
        ) WITH &&
      );
  END IF;
END $$;