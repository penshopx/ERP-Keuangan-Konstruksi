import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export type TryWithDatabaseAdvisoryLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

export async function tryWithDatabaseAdvisoryLock<T>(
  lockName: string,
  operation: () => Promise<T>,
): Promise<TryWithDatabaseAdvisoryLockResult<T>> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [lockName],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await operation() };
  } finally {
    try {
      if (acquired) {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [lockName],
        );
      }
    } finally {
      client.release();
    }
  }
}

const REQUIRED_MIGRATIONS = [
  "0001_prevent_overlapping_tax_rule_periods.sql",
  "0003_add_operational_state.sql",
];

export async function assertRequiredDatabaseMigrations(): Promise<void> {
  const historyTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('app_migrations') IS NOT NULL AS exists",
  );
  const appliedMigrationCount = historyTable.rows[0]?.exists
    ? (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM app_migrations WHERE name = ANY($1::text[])",
          [REQUIRED_MIGRATIONS],
        )
      ).rows[0]?.count ?? 0
    : 0;

  const result = await pool.query<{
    valid_period_constraint: boolean;
    overlap_constraint: boolean;
    operational_state_shape: boolean;
  }>(`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tax_rule_versions_valid_period'
          AND conrelid = to_regclass('tax_rule_versions')
      ) AS valid_period_constraint,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tax_rule_versions_no_overlapping_periods'
          AND conrelid = to_regclass('tax_rule_versions')
      ) AS overlap_constraint,
      (
        SELECT count(*) = 3
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'operational_state'
          AND (
            (column_name = 'key' AND data_type = 'text' AND is_nullable = 'NO')
            OR (
              column_name IN ('last_successful_at', 'updated_at')
              AND data_type = 'timestamp with time zone'
              AND is_nullable = 'NO'
            )
          )
      ) AS operational_state_shape
  `);

  const status = result.rows[0];
  if (
    appliedMigrationCount !== REQUIRED_MIGRATIONS.length ||
    !status ||
    !status.valid_period_constraint ||
    !status.overlap_constraint ||
    !status.operational_state_shape
  ) {
    throw new Error(
      `Mandatory database migrations ${REQUIRED_MIGRATIONS.join(", ")} are not fully applied. ` +
        "Run `pnpm --filter @workspace/db migrate` before starting the API.",
    );
  }
}

export * from "./schema";
