import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { pool } from "@workspace/db";

type ExplainPlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: ExplainPlanNode[];
};

const databaseSuiteLockName = "api-server:persistence-integration-shared-fixtures";
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
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [databaseSuiteLockName]);
    lockHeld = true;
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
  } finally {
    try {
      await client.query("DELETE FROM audit_logs WHERE actor_user_id = $1", [actorUserId]);
      await client.query("ANALYZE audit_logs");
    } finally {
      if (lockHeld) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [databaseSuiteLockName]);
      }
      client.release();
    }
  }
});