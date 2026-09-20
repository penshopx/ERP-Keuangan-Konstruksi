import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  actualCostAllocationsTable, auditLogsTable, budgetAlertsTable, commitmentLinesTable,
  commitmentTable, db, pool, projectCostCodesTable, projectsTable, rabBaselinesTable,
} from "@workspace/db";
import { createApiRouter } from "../routes/index";
import type { AccessContext } from "../middlewares/access";
import { evaluateBudgetAlerts } from "./budget-alerts";
import {
  acquirePersistenceDatabaseSuiteLock, releasePersistenceDatabaseSuiteLock,
  setDatabaseSuitePoolStatementTimeout,
} from "../testing/database-suite-lock";

const id = randomUUID();
const projectId = `budget-alert-test-${id}`;
const baselineId = `budget-baseline-${id}`;
const costCodeId = `budget-cost-${id}`;
const commitmentId = `budget-commitment-${id}`;
const lineId = `budget-line-${id}`;
const userId = `budget-owner-${id}`;
let lock: Awaited<ReturnType<typeof acquirePersistenceDatabaseSuiteLock>>;
let currentAccess: AccessContext;
let server: ReturnType<express.Application["listen"]>;

const access = (role: AccessContext["role"], assignedProjectIds: string[] = []): AccessContext => ({
  userId, displayName: role, role, assignedProjectIds, permissions: ["projects:view", "budget-alerts:manage"],
});

function appFor() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.access = currentAccess; next(); });
  app.use("/api", createApiRouter((_req, _res, next) => next()));
  return app;
}
async function request(context: AccessContext, path: string, method = "GET") {
  currentAccess = context;
  const address = server.address() as { port: number };
  return fetch(`http://127.0.0.1:${address.port}/api${path}`, { method });
}

before(async () => {
  setDatabaseSuitePoolStatementTimeout("Budget alert integration suite", 120_000);
  lock = await acquirePersistenceDatabaseSuiteLock(120_000);
  await db.insert(projectsTable).values({
    id: projectId, code: `BA-${id.slice(0, 8)}`, name: "Budget alert integration",
    owner: userId, contractValue: 1_000, budget: 1_000, actualCost: 0, progress: 0,
    status: "BERJALAN", health: "SEHAT", endDate: "2030-01-01",
  });
  await db.insert(rabBaselinesTable).values({ id: baselineId, projectId, version: 1, status: "APPROVED" });
  await db.insert(projectCostCodesTable).values({ id: costCodeId, projectId, code: "BA.01", name: "Budget alert" });
  currentAccess = access("DIRECTOR");
  server = appFor().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
});

after(async () => {
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await lock.query(
      "DELETE FROM audit_logs WHERE entity = 'BudgetAlert' AND metadata->>'projectId' = $1",
      [projectId],
    );
    await lock.query("DELETE FROM actual_cost_allocations WHERE project_id = $1", [projectId]);
    await lock.query("DELETE FROM commitment_events WHERE commitment_id IN (SELECT id FROM commitments WHERE project_id = $1)", [projectId]);
    await lock.query("DELETE FROM commitment_lines WHERE commitment_id IN (SELECT id FROM commitments WHERE project_id = $1)", [projectId]);
    await lock.query("DELETE FROM commitments WHERE project_id = $1", [projectId]);
    await lock.query("DELETE FROM budget_alerts WHERE project_id = $1", [projectId]);
    await lock.query("DELETE FROM rab_items WHERE baseline_id IN (SELECT id FROM rab_baselines WHERE project_id = $1)", [projectId]);
    await lock.query("DELETE FROM project_cost_codes WHERE project_id = $1", [projectId]);
    await lock.query("DELETE FROM rab_baselines WHERE project_id = $1", [projectId]);
    await lock.query("DELETE FROM projects WHERE id = $1", [projectId]);
  } finally {
    await releasePersistenceDatabaseSuiteLock(lock);
    await pool.end();
  }
});

test("persists, deduplicates, resolves, reopens, and authorizes budget alerts through production paths", async () => {
  // At zero exposure and 0% progress EAC is exactly budget, so neither rule breaches.
  assert.equal((await evaluateBudgetAlerts([projectId])).length, 0);
  assert.equal((await db.select().from(budgetAlertsTable).where(eq(budgetAlertsTable.projectId, projectId))).length, 0);

  // Actual above 90% creates a persisted alert with causal evidence and audit.
  await db.insert(actualCostAllocationsTable).values({
    id: `actual-${id}`, projectId, baselineId, costCodeId, sourceType: "TEST", sourceId: id, amount: 901,
  });
  const created = await evaluateBudgetAlerts([projectId]);
  assert.equal(created.length, 2);
  const projected = created.find((alert) => alert.alertType === "PROJECTED_EXPOSURE")!;
  assert.equal((projected.evidence as Record<string, unknown>).projectedExposure, 901);
  assert.equal((await db.select().from(auditLogsTable).where(eq(auditLogsTable.entityId, projected.id))).some((row) => row.action === "ALERT_DIBUAT"), true);

  // Repeat evaluation is idempotent and does not create a second active cycle.
  await evaluateBudgetAlerts([projectId]);
  assert.equal((await db.select().from(budgetAlertsTable).where(and(eq(budgetAlertsTable.projectId, projectId), inArray(budgetAlertsTable.status, ["OPEN", "ACKNOWLEDGED"])))).length, 2);

  // Clearing actuals auto-resolves, then re-breach opens a new cycle.
  await db.delete(actualCostAllocationsTable).where(eq(actualCostAllocationsTable.projectId, projectId));
  await evaluateBudgetAlerts([projectId]);
  const resolved = await db.select().from(budgetAlertsTable).where(eq(budgetAlertsTable.id, projected.id));
  assert.equal(resolved[0].status, "RESOLVED");
  assert.equal((await db.select().from(auditLogsTable).where(eq(auditLogsTable.entityId, projected.id))).some((row) => row.action === "ALERT_AUTO_DISELESAIKAN"), true);
  await db.insert(actualCostAllocationsTable).values({ id: `actual-2-${id}`, projectId, baselineId, costCodeId, sourceType: "TEST", sourceId: `reb-${id}`, amount: 901 });
  const reopened = await evaluateBudgetAlerts([projectId]);
  assert.equal(reopened.some((alert) => alert.id !== created[0].id), true);

  // Commitment approval and invoicing alter exposure/evidence without duplicating the active alert.
  await db.insert(commitmentTable).values({
    id: commitmentId, projectId, baselineId, documentType: "PO", documentNumber: `BA-${id}`,
    vendorName: "Integration vendor", status: "APPROVED", totalAmount: 200, createdBy: userId,
  });
  await db.insert(commitmentLinesTable).values({ id: lineId, commitmentId, costCodeId, description: "Test", amount: 200 });
  await evaluateBudgetAlerts([projectId]);
  await db.update(commitmentLinesTable).set({ invoicedAmount: 200 }).where(eq(commitmentLinesTable.id, lineId));
  const afterInvoice = await evaluateBudgetAlerts([projectId]);
  assert.equal((await db.select().from(budgetAlertsTable).where(and(eq(budgetAlertsTable.projectId, projectId), inArray(budgetAlertsTable.status, ["OPEN", "ACKNOWLEDGED"])))).length, 2);
  assert.equal(afterInvoice.length >= 1, true);

  // Route access: SITE_MANAGER/PROCUREMENT and unassigned PM are rejected.
  const alertId = (await db.select().from(budgetAlertsTable).where(and(eq(budgetAlertsTable.projectId, projectId), inArray(budgetAlertsTable.status, ["OPEN", "ACKNOWLEDGED"])))).at(0)!.id;
  assert.equal((await request(access("SITE_MANAGER"), `/budget-alerts/${alertId}/acknowledge`, "POST")).status, 403);
  assert.equal((await request(access("PROCUREMENT"), `/budget-alerts/${alertId}/resolve`, "POST")).status, 403);
  assert.equal((await request(access("PROJECT_MANAGER"), `/budget-alerts/${alertId}/acknowledge`, "POST")).status, 403);
  assert.equal((await request(access("PROJECT_MANAGER", [projectId]), `/budget-alerts/${alertId}/acknowledge`, "POST")).status, 200);
  assert.equal((await request(access("DIRECTOR"), `/budget-alerts/${alertId}/resolve`, "POST")).status, 200);
});