import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
const defaultDatabaseClientTimeoutMs = 60_000;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function readPositiveTimeout(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer; received ${process.env[name]}`);
  }
  return value;
}

const databaseQueryTimeoutMs = readPositiveTimeout(
  "DATABASE_QUERY_TIMEOUT_MS",
  defaultDatabaseClientTimeoutMs,
);
const databaseConnectionTimeoutMs = readPositiveTimeout(
  "DATABASE_CONNECTION_TIMEOUT_MS",
  defaultDatabaseClientTimeoutMs,
);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  query_timeout: databaseQueryTimeoutMs,
  connectionTimeoutMillis: databaseConnectionTimeoutMs,
});
export const db = drizzle(pool, { schema });

export function createDatabasePool(config: pg.PoolConfig): pg.Pool {
  return new Pool(config);
}

export type DatabasePoolTimeouts = {
  statementTimeoutMs: number;
  queryTimeoutMs: number;
  connectionTimeoutMs: number;
};

export function configureDatabasePoolTimeouts({
  statementTimeoutMs,
  queryTimeoutMs,
  connectionTimeoutMs,
}: DatabasePoolTimeouts): void {
  pool.options.statement_timeout = statementTimeoutMs;
  pool.options.query_timeout = queryTimeoutMs;
  pool.options.connectionTimeoutMillis = connectionTimeoutMs;
}

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
  "0004_restrict_project_status.sql",
  "0006_add_shared_invitation_reconciliation_state.sql",
  "0007_index_pending_resend_compensation_audits.sql",
  "0010_add_commitment_ledger.sql",
  "0011_add_budget_alerts.sql",
  "0015_share_reconciliation_alert_incidents.sql",
  "0016_record_operational_alert_delivery.sql",
  "0017_add_copilot_usage.sql",
  "0018_complete_petty_cash.sql",
  "0019_unique_petty_cash_location.sql",
  "0020_petty_cash_approval_matrix.sql",
  "0021_vendor_matching.sql",
  "0022_allow_vendor_credit_offsets.sql",
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
    project_status_constraint: boolean;
    operational_state_shape: boolean;
    invitation_reconciliation_state_shape: boolean;
    pending_resend_compensation_index: boolean;
    commitment_ledger_shape: boolean;
    budget_alerts_shape: boolean;
    operational_alert_delivery_status_shape: boolean;
    copilot_usage_shape: boolean;
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
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'projects_status_supported'
          AND conrelid = to_regclass('projects')
      ) AS project_status_constraint,
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
      ) AS operational_state_shape,
      (
        SELECT count(*) = 12
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'invitation_reconciliation_state'
          AND (
            (
              column_name = 'key'
              AND data_type = 'text'
              AND is_nullable = 'NO'
            )
            OR (
              column_name = 'consecutive_failures'
              AND data_type = 'integer'
              AND is_nullable = 'NO'
            )
            OR (
              column_name IN (
                'last_failure_at',
                'last_success_at',
                'last_completed_at',
                'last_run_at'
              )
              AND data_type = 'timestamp with time zone'
              AND is_nullable = 'YES'
            )
            OR (
              column_name = 'last_run'
              AND data_type = 'jsonb'
              AND is_nullable = 'YES'
            )
            OR (
              column_name IN ('alert_incident_active', 'degraded_alert_sent')
              AND data_type = 'boolean'
              AND is_nullable = 'NO'
            )
            OR (
              column_name = 'alert_incident_reason'
              AND data_type = 'text'
              AND is_nullable = 'YES'
            )
            OR (
              column_name IN ('monitoring_started_at', 'updated_at')
              AND data_type = 'timestamp with time zone'
              AND is_nullable = 'NO'
            )
          )
      ) AS invitation_reconciliation_state_shape,
      EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'audit_logs'
          AND indexname = 'audit_logs_pending_resend_compensation_idx'
      ) AS pending_resend_compensation_index,
      (
        to_regclass('commitments') IS NOT NULL
        AND to_regclass('commitment_lines') IS NOT NULL
        AND to_regclass('project_cost_codes') IS NOT NULL
        AND to_regclass('actual_cost_allocations') IS NOT NULL
      ) AS commitment_ledger_shape,
      (
        to_regclass('budget_alert_thresholds') IS NOT NULL
        AND to_regclass('budget_alerts') IS NOT NULL
      ) AS budget_alerts_shape,
      (
        SELECT count(*) = 4
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'operational_alert_delivery_status'
          AND (
            (
              column_name IN ('source', 'last_result')
              AND data_type = 'text'
              AND is_nullable = 'NO'
            )
            OR (
              column_name IN ('last_attempt_at', 'updated_at')
              AND data_type = 'timestamp with time zone'
              AND is_nullable = 'NO'
            )
          )
       ) AS operational_alert_delivery_status_shape,
       (to_regclass('copilot_limits') IS NOT NULL
         AND to_regclass('copilot_usage') IS NOT NULL) AS copilot_usage_shape
  `);

  const status = result.rows[0];
  if (
    appliedMigrationCount !== REQUIRED_MIGRATIONS.length ||
    !status ||
    !status.valid_period_constraint ||
    !status.overlap_constraint ||
    !status.project_status_constraint ||
    !status.operational_state_shape ||
    !status.invitation_reconciliation_state_shape ||
    !status.pending_resend_compensation_index
    || !status.commitment_ledger_shape
    || !status.budget_alerts_shape
     || !status.operational_alert_delivery_status_shape
     || !status.copilot_usage_shape
  ) {
    throw new Error(
      `Mandatory database migrations ${REQUIRED_MIGRATIONS.join(", ")} are not fully applied. ` +
        "Run `pnpm --filter @workspace/db migrate` before starting the API.",
    );
  }
}

export * from "./schema";
