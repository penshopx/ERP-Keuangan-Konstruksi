-- Migration 0001 preserved the period after the final bounded override, but
-- legacy groups with multiple separated overrides could still have gaps.
-- Reconstruct those gaps from the original predecessor and its final
-- continuation without changing already-applied migration history.
WITH legacy_baselines AS (
  SELECT
    predecessor.*,
    continuation.effective_from AS final_continuation_from
  FROM tax_rule_versions AS predecessor
  JOIN tax_rule_versions AS continuation
    ON continuation.id = predecessor.id || '-continuation-' || continuation.effective_from::text
    AND continuation.service_type = predecessor.service_type
    AND continuation.qualification IS NOT DISTINCT FROM predecessor.qualification
    AND continuation.requires_sbu = predecessor.requires_sbu
    AND continuation.supplier_pkp = predecessor.supplier_pkp
    AND continuation.government_collector = predecessor.government_collector
    AND continuation.integrated = predecessor.integrated
  WHERE predecessor.effective_to IS NOT NULL
    AND continuation.effective_to IS NULL
),
missing_continuations AS (
  SELECT
    baseline.*,
    override.effective_to + 1 AS gap_from,
    MIN(next_rule.effective_from) - 1 AS gap_to
  FROM legacy_baselines AS baseline
  JOIN tax_rule_versions AS override
    ON override.service_type = baseline.service_type
    AND override.qualification IS NOT DISTINCT FROM baseline.qualification
    AND override.requires_sbu = baseline.requires_sbu
    AND override.supplier_pkp = baseline.supplier_pkp
    AND override.government_collector = baseline.government_collector
    AND override.integrated = baseline.integrated
    AND override.effective_from > baseline.effective_to
    AND override.effective_to IS NOT NULL
    AND override.effective_to < baseline.final_continuation_from
  JOIN tax_rule_versions AS next_rule
    ON next_rule.service_type = baseline.service_type
    AND next_rule.qualification IS NOT DISTINCT FROM baseline.qualification
    AND next_rule.requires_sbu = baseline.requires_sbu
    AND next_rule.supplier_pkp = baseline.supplier_pkp
    AND next_rule.government_collector = baseline.government_collector
    AND next_rule.integrated = baseline.integrated
    AND next_rule.effective_from > override.effective_to
  GROUP BY
    baseline.id, baseline.version, baseline.effective_from, baseline.effective_to,
    baseline.regulatory_source, baseline.service_type, baseline.qualification,
    baseline.requires_sbu, baseline.supplier_pkp, baseline.government_collector,
    baseline.integrated, baseline.dpp_rate_basis_points,
    baseline.ppn_rate_basis_points, baseline.pph_final_rate_basis_points,
    baseline.pph_23_rate_basis_points, baseline.created_at,
    baseline.final_continuation_from, override.effective_to
  HAVING MIN(next_rule.effective_from) > override.effective_to + 1
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
  id || '-continuation-' || gap_from::text,
  version || '-CONT-' || gap_from::text,
  gap_from,
  gap_to,
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
FROM missing_continuations
ON CONFLICT (id) DO NOTHING;