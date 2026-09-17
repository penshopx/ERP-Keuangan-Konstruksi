import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { pool } from "@workspace/db";
import {
  acquireDatabaseSuiteLock,
  defaultDatabaseSuiteStatementTimeoutMs,
  defaultPersistenceDatabaseSuiteLockTimeoutMs,
  isDatabaseStatementTimeout,
  persistenceDatabaseSuiteLockName,
  releaseDatabaseSuiteLock,
  setDatabaseSuiteStatementTimeout,
} from "../testing/database-suite-lock";

type ExplainPlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: ExplainPlanNode[];
};

const databaseSuiteLockTimeoutMs = Number(
  process.env.ACTIVITY_QUERY_PLAN_TEST_LOCK_TIMEOUT_MS ?? defaultPersistenceDatabaseSuiteLockTimeoutMs,
);
const databaseStatementTimeoutMs = Number(
  process.env.ACTIVITY_QUERY_PLAN_TEST_STATEMENT_TIMEOUT_MS ?? defaultDatabaseSuiteStatementTimeoutMs,
);
const databaseSuiteLockOptions = {
  lockName: persistenceDatabaseSuiteLockName,
  suiteName: "activity query-plan validation",
};
const regressionUserIdPattern = "^test-user-[0-9a-f-]{36}$";
const runId = randomUUID();
const actorUserId = `test-user-${runId}`;

function flattenExplainPlan(node: ExplainPlanNode): ExplainPlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenExplainPlan)];
}

after(async () => {
  await pool.end();
});

test("activity timeline uses its timestamp index at representative volume", async () => {
  if (!Number.isFinite(databaseSuiteLockTimeoutMs) || databaseSuiteLockTimeoutMs <= 0) {
    throw new Error(
      `ACTIVITY_QUERY_PLAN_TEST_LOCK_TIMEOUT_MS must be a positive number; received ${
        process.env.ACTIVITY_QUERY_PLAN_TEST_LOCK_TIMEOUT_MS
      }`,
    );
  }
  const client = await acquireDatabaseSuiteLock({
    ...databaseSuiteLockOptions,
    timeoutMs: databaseSuiteLockTimeoutMs,
  });
  let testError: unknown;
  try {
    await setDatabaseSuiteStatementTimeout(
      client,
      databaseSuiteLockOptions.suiteName,
      databaseStatementTimeoutMs,
    );
    await client.query("DELETE FROM audit_logs WHERE actor_user_id ~ $1", [regressionUserIdPattern]);
    await client.query(
      `INSERT INTO audit_logs (
        id, action, entity, entity_id, detail, "user", actor_user_id, actor_role, tone, metadata, "timestamp"
      )
      SELECT
        $1 || '-' || sequence_number,
        'TIMELINE PLAN TEST',
        'Regression',
        $1,
        'Representative audit timeline fixture',
        'Regression Test',
        $2,
        'DIRECTOR',
        'info',
        NULL,
        TIMESTAMPTZ '2080-01-01 00:00:00+00' + sequence_number * INTERVAL '1 second'
      FROM generate_series(1, 20000) AS sequence_number`,
      [`test-audit-plan-${runId}`, actorUserId],
    );
    await client.query("ANALYZE audit_logs");

    const explained = await client.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
      `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT *
       FROM audit_logs
       ORDER BY "timestamp" DESC
       LIMIT 100`,
    );
    const plan = explained.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
    assert.ok(plan, "PostgreSQL did not return a JSON query plan");
    const nodes = flattenExplainPlan(plan);
    assert.ok(
      nodes.some((node) =>
        (node["Node Type"] === "Index Scan" || node["Node Type"] === "Index Only Scan")
        && node["Relation Name"] === "audit_logs"
        && node["Index Name"] === "audit_logs_timestamp_idx"),
      `Expected activity timeline to use audit_logs_timestamp_idx, received: ${JSON.stringify(plan)}`,
    );
    assert.equal(
      nodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "audit_logs"),
      false,
      `Activity timeline regressed to a sequential scan: ${JSON.stringify(plan)}`,
    );
  } catch (error) {
    testError = isDatabaseStatementTimeout(error)
      ? new Error(
        `Activity query-plan database query exceeded the ${databaseStatementTimeoutMs}ms statement timeout`,
        { cause: error },
      )
      : error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await client.query("DELETE FROM audit_logs WHERE actor_user_id = $1", [actorUserId]);
      await client.query("ANALYZE audit_logs");
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try {
        await releaseDatabaseSuiteLock(client, databaseSuiteLockOptions);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (testError) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [testError, ...cleanupErrors],
          testError instanceof Error ? testError.message : "Activity query-plan validation failed",
        );
      }
      throw testError;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Activity query-plan cleanup or lock release failed");
    }
  }
});