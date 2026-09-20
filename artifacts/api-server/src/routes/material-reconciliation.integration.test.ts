import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  inventoryMovementsTable,
  materialVarianceEventsTable,
  materialVarianceExceptionsTable,
  materialWasteToleranceVersionsTable,
  materialsTable,
  pool,
  projectCostCodesTable,
  projectsTable,
  rabBaselinesTable,
  rabItemsTable,
  rabMaterialRequirementsTable,
} from "@workspace/db";
import { createApiRouter } from "./index";
import type { AccessContext } from "../middlewares/access";

const runId = randomUUID();
const projectId = `material-project-${runId}`;
const foreignProjectId = `material-foreign-project-${runId}`;
const baselineId = `material-baseline-${runId}`;
const costCodeId = `material-cost-code-${runId}`;
const foreignCostCodeId = `material-foreign-cost-code-${runId}`;
const rabItemId = `material-rab-item-${runId}`;
const access: AccessContext = {
  userId: `material-user-${runId}`,
  displayName: "Material Test",
  role: "DIRECTOR",
  assignedProjectIds: [],
  permissions: ["projects:view", "projects:write"],
};
let lockClient: { query: (text: string) => Promise<unknown>; release: () => void };

function appFor() {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter((req, _res, next) => {
    req.access = access;
    next();
  }));
  return app;
}

async function json(base: string, path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const text = await response.text();
  return { response, body: JSON.parse(text) as Record<string, any> };
}

before(async () => {
  lockClient = await pool.connect();
  await lockClient.query("SET statement_timeout = '10000'");
  await lockClient.query("SELECT pg_advisory_lock(hashtext('material-reconciliation-integration-suite'))");
  await db.insert(projectsTable).values([
    {
      id: projectId, code: projectId, name: "Material reconciliation", owner: "Test",
      contractValue: 1_000_000, budget: 100_000, actualCost: 0, progress: 0,
      status: "BERJALAN", health: "SEHAT", endDate: "2099-12-31", wbsCount: 1,
    },
    {
      id: foreignProjectId, code: foreignProjectId, name: "Foreign material project", owner: "Test",
      contractValue: 1_000_000, budget: 100_000, actualCost: 0, progress: 0,
      status: "BERJALAN", health: "SEHAT", endDate: "2099-12-31", wbsCount: 0,
    },
  ]);
  await db.insert(rabBaselinesTable).values({ id: baselineId, projectId, version: 1, status: "DISETUJUI" });
  await db.insert(projectCostCodesTable).values([
    { id: costCodeId, projectId, code: "MAT-01", name: "Pekerjaan material" },
    { id: foreignCostCodeId, projectId: foreignProjectId, code: "FOREIGN", name: "Foreign cost code" },
  ]);
  await db.insert(rabItemsTable).values({
    id: rabItemId,
    baselineId,
    costCodeId,
    code: "MAT-01",
    name: "Pekerjaan material",
    category: "STRUKTUR",
    parentCode: null,
    level: 1,
    unit: "m2",
    quantityBasisPoints: 1_000,
    unitPrice: 10_000,
    materialCost: 100_000,
    laborCost: 0,
    equipmentCost: 0,
    budget: 100_000,
    committed: 0,
    actual: 0,
  });
});

after(async () => {
  try {
    const exceptions = await db.select({ id: materialVarianceExceptionsTable.id }).from(materialVarianceExceptionsTable)
      .where(eq(materialVarianceExceptionsTable.projectId, projectId));
    if (exceptions.length) {
      await db.delete(materialVarianceEventsTable).where(inArray(materialVarianceEventsTable.exceptionId, exceptions.map((row) => row.id)));
    }
    await db.delete(auditLogsTable).where(eq(auditLogsTable.actorUserId, access.userId));
    await db.delete(materialVarianceExceptionsTable).where(eq(materialVarianceExceptionsTable.projectId, projectId));
    await db.delete(inventoryMovementsTable).where(eq(inventoryMovementsTable.projectId, projectId));
    await db.delete(materialWasteToleranceVersionsTable).where(eq(materialWasteToleranceVersionsTable.projectId, projectId));
    const requirements = await db.select({ materialId: rabMaterialRequirementsTable.materialId }).from(rabMaterialRequirementsTable)
      .where(eq(rabMaterialRequirementsTable.baselineId, baselineId));
    await db.delete(rabMaterialRequirementsTable).where(eq(rabMaterialRequirementsTable.baselineId, baselineId));
    await db.delete(projectsTable).where(inArray(projectsTable.id, [projectId, foreignProjectId]));
    if (requirements.length) {
      await db.delete(materialsTable).where(inArray(materialsTable.id, requirements.map((row) => row.materialId)));
    }
  } finally {
    await lockClient?.query("SELECT pg_advisory_unlock(hashtext('material-reconciliation-integration-suite'))");
    lockClient?.release();
  }
});

test("material setup reconciles deterministically, rejects foreign cost codes, and reopens recurrence", async () => {
  const server = appFor().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  try {
    const configured = await json(base, `/projects/${projectId}/material-requirements`, {
      method: "POST",
      body: JSON.stringify({
        baselineId,
        rabItemId,
        materialCode: `MAT-${runId}`,
        materialName: "Material test",
        unit: "kg",
        analysisVersion: 1,
        coefficient: 1,
        tolerancePercent: 10,
        effectiveFrom: "2026-01-01",
        reason: "Metode kerja pengujian",
      }),
    });
    assert.equal(configured.response.status, 201);
    const materialId = String(configured.body.materialId);

    const foreignMovement = await json(base, `/projects/${projectId}/inventory-movements`, {
      method: "POST",
      body: JSON.stringify({
        baselineId,
        costCodeId: foreignCostCodeId,
        materialId,
        movementType: "ISSUED",
        quantity: 1,
        unit: "kg",
        baseQuantity: 1,
        sourceDocumentType: "ISSUE",
        sourceDocumentId: `foreign-${runId}`,
        sourceDocumentNumber: "FOREIGN",
        occurredAt: "2026-09-20T00:00:00.000Z",
      }),
    });
    assert.equal(foreignMovement.response.status, 400);

    const firstMovement = await json(base, `/projects/${projectId}/inventory-movements`, {
      method: "POST",
      body: JSON.stringify({
        baselineId,
        costCodeId,
        materialId,
        movementType: "ISSUED",
        quantity: 12,
        unit: "kg",
        baseQuantity: 12,
        sourceDocumentType: "ISSUE",
        sourceDocumentId: `issue-1-${runId}`,
        sourceDocumentNumber: "ISSUE-1",
        occurredAt: "2026-09-20T00:00:00.000Z",
      }),
    });
    assert.equal(firstMovement.response.status, 201);

    const [first, concurrent] = await Promise.all([
      json(base, `/projects/${projectId}/material-reconciliation`),
      json(base, `/projects/${projectId}/material-reconciliation`),
    ]);
    assert.equal(first.response.status, 200);
    assert.equal(concurrent.response.status, 200);
    assert.equal(first.body.items[0].theoreticalQuantity, 10);
    assert.equal(first.body.items[0].consumedQuantity, 12);
    assert.equal(first.body.items[0].exceedsTolerance, true);
    const exceptionId = String(first.body.items[0].exception.id);
    assert.equal(concurrent.body.items[0].exception.id, exceptionId);
    assert.equal((await db.select().from(materialVarianceExceptionsTable).where(eq(materialVarianceExceptionsTable.id, exceptionId))).length, 1);
    assert.equal((await db.select().from(materialVarianceEventsTable).where(eq(materialVarianceEventsTable.exceptionId, exceptionId))).filter((event) => event.eventType === "DETECTED").length, 1);

    const closed = await json(base, `/projects/${projectId}/material-exceptions/${exceptionId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "CLOSED", classification: "WASTE", disposition: "Waste diverifikasi dan ditindaklanjuti." }),
    });
    assert.equal(closed.response.status, 200);
    assert.equal(closed.body.status, "CLOSED");

    const secondMovement = await json(base, `/projects/${projectId}/inventory-movements`, {
      method: "POST",
      body: JSON.stringify({
        baselineId,
        costCodeId,
        materialId,
        movementType: "ISSUED",
        quantity: 1,
        unit: "kg",
        baseQuantity: 1,
        sourceDocumentType: "ISSUE",
        sourceDocumentId: `issue-2-${runId}`,
        sourceDocumentNumber: "ISSUE-2",
        occurredAt: "2026-09-20T01:00:00.000Z",
      }),
    });
    assert.equal(secondMovement.response.status, 201);
    const reopened = await json(base, `/projects/${projectId}/material-reconciliation`);
    assert.equal(reopened.response.status, 200);
    assert.equal(reopened.body.items[0].exception.status, "OPEN");
    assert.equal(reopened.body.openExceptionCount, 1);
    assert.equal(reopened.body.items[0].exception.events.filter((event: Record<string, unknown>) => event.eventType === "REOPENED").length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});