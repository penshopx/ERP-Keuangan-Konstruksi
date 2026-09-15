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

const REQUIRED_MIGRATION = "0001_prevent_overlapping_tax_rule_periods.sql";

export async function assertRequiredDatabaseMigrations(): Promise<void> {
  const historyTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('app_migrations') IS NOT NULL AS exists",
  );
  const migrationApplied = historyTable.rows[0]?.exists
    ? (
        await pool.query(
          "SELECT 1 FROM app_migrations WHERE name = $1 LIMIT 1",
          [REQUIRED_MIGRATION],
        )
      ).rowCount === 1
    : false;

  const result = await pool.query<{
    valid_period_constraint: boolean;
    overlap_constraint: boolean;
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
      ) AS overlap_constraint
  `);

  const status = result.rows[0];
  if (
    !migrationApplied ||
    !status ||
    !status.valid_period_constraint ||
    !status.overlap_constraint
  ) {
    throw new Error(
      `Mandatory database migration ${REQUIRED_MIGRATION} is not fully applied. ` +
        "Run `pnpm --filter @workspace/db migrate` before starting the API.",
    );
  }
}

export * from "./schema";
