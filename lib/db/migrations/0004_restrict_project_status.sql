DO $$
DECLARE
  unsupported_statuses text;
BEGIN
  SELECT string_agg(quote_literal(status), ', ' ORDER BY status)
  INTO unsupported_statuses
  FROM (
    SELECT DISTINCT status
    FROM projects
    WHERE status NOT IN ('PERSIAPAN', 'BERJALAN', 'SELESAI')
  ) AS unsupported;

  IF unsupported_statuses IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot restrict projects.status: unsupported existing values: %',
      unsupported_statuses
      USING HINT = 'Correct these project statuses explicitly before rerunning the migration.';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'projects_status_supported'
      AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_status_supported
      CHECK (status IN ('PERSIAPAN', 'BERJALAN', 'SELESAI'));
  END IF;
END
$$;