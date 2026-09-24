import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import http from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogsTable, db, invoicesTable, projectsTable, rabBaselinesTable,
} from "@workspace/db";
import { createAiControlPlaneRouter } from "./ai-control-plane";
import type { AccessContext } from "../middlewares/access";
import {
  acquirePersistenceDatabaseSuiteLock,
  defaultDatabaseSuiteStatementTimeoutMs,
  releasePersistenceDatabaseSuiteLock,
  setDatabaseSuitePoolStatementTimeout,
  type DatabaseSuiteLockClient,
} from "../testing/database-suite-lock";

const suite = "AI control-plane audit integration";
const runId = randomUUID();
const targetProject = `ai-audit-project-${runId}`;
const otherProject = `ai-audit-other-${runId}`;
const targetInvoice = `ai-audit-invoice-${runId}`;
const targetRab = `ai-audit-rab-${runId}`;
const targetAuditIds = [
  `ai-audit-meta-${runId}`, `ai-audit-project-event-${runId}`,
  `ai-audit-invoice-event-${runId}`, `ai-audit-rab-event-${runId}`,
];
let lock: DatabaseSuiteLockClient | undefined;

before(async () => {
  setDatabaseSuitePoolStatementTimeout(suite, defaultDatabaseSuiteStatementTimeoutMs);
  lock = await acquirePersistenceDatabaseSuiteLock();
  await db.insert(projectsTable).values([
    { id: targetProject, code: `AI-${runId.slice(0, 8)}`, name: "Target", owner: "Test",
      contractValue: 1000, budget: 1000, actualCost: 10, endDate: "2030-01-01" },
    { id: otherProject, code: `AO-${runId.slice(0, 8)}`, name: "Other", owner: "Test",
      contractValue: 1000, budget: 1000, actualCost: 10, endDate: "2030-01-01" },
  ]);
  await db.insert(rabBaselinesTable).values({
    id: targetRab, projectId: targetProject, version: 1, status: "FINAL",
  });
  await db.insert(invoicesTable).values({
    id: targetInvoice, number: `AI-${runId}`, projectId: targetProject,
    projectCode: `AI-${runId.slice(0, 8)}`, projectName: "Target", period: "2025-01",
    dpp: 100, ppn: 11, pphFinal: 2, pph23: 0, retention: 0, total: 109,
    status: "DRAFT", issuedAt: "2025-01-01", taxRuleVersionId: null,
  });
  await db.insert(auditLogsTable).values([
    { id: targetAuditIds[0], action: "TARGET_META", entity: "Dokumen", entityId: null,
      detail: "metadata target", user: "test", tone: "info", metadata: { projectId: targetProject },
      timestamp: new Date("2025-01-01T00:00:00Z") },
    { id: targetAuditIds[1], action: "TARGET_PROJECT", entity: "Proyek", entityId: targetProject,
      detail: "project target", user: "test", tone: "info", metadata: {},
      timestamp: new Date("2025-01-01T00:00:01Z") },
    { id: targetAuditIds[2], action: "TARGET_INVOICE", entity: "Invoice", entityId: targetInvoice,
      detail: "invoice target", user: "test", tone: "info", metadata: {},
      timestamp: new Date("2025-01-01T00:00:02Z") },
    { id: targetAuditIds[3], action: "TARGET_RAB", entity: "RAB", entityId: targetRab,
      detail: "rab target", user: "test", tone: "info", metadata: {},
      timestamp: new Date("2025-01-01T00:00:03Z") },
    ...Array.from({ length: 205 }, (_, index) => ({
      id: `ai-audit-unrelated-${runId}-${index}`, action: "UNRELATED", entity: "Dokumen",
      entityId: null, detail: "unrelated", user: "test", tone: "info", metadata: { projectId: otherProject },
      timestamp: new Date(`2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`),
    })),
  ]);
});

after(async () => {
  await db.delete(auditLogsTable).where(
    inArray(auditLogsTable.id, [...targetAuditIds, ...Array.from({ length: 205 }, (_, index) =>
      `ai-audit-unrelated-${runId}-${index}`)]),
  );
  await db.delete(invoicesTable).where(eq(invoicesTable.id, targetInvoice));
  await db.delete(rabBaselinesTable).where(eq(rabBaselinesTable.id, targetRab));
  await db.delete(projectsTable).where(inArray(projectsTable.id, [targetProject, otherProject]));
  if (lock) await releasePersistenceDatabaseSuiteLock(lock);
  lock = undefined;
});

test("production audit_search resolves all ownership forms before LIMIT", async () => {
  const access: AccessContext = {
    userId: `ai-audit-user-${runId}`, displayName: "Test", role: "PROJECT_MANAGER",
    assignedProjectIds: [targetProject], permissions: ["audit:view"],
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.access = access; next(); });
  app.use(createAiControlPlaneRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ai/copilot`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "audit_search", projectId: targetProject }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { result: Array<{ id: string }> };
    assert.deepEqual(new Set(body.result.map((row) => row.id)), new Set(targetAuditIds));
    assert.equal(body.result.some((row) => row.id.includes("unrelated")), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("project-scoped portfolio wording returns only the active project", async () => {
  const access: AccessContext = {
    userId: `ai-project-user-${runId}`, displayName: "Test", role: "PROJECT_MANAGER",
    assignedProjectIds: [targetProject, otherProject], permissions: ["projects:view"],
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.access = access; next(); });
  app.use(createAiControlPlaneRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ai/copilot`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Ringkas semua proyek", projectId: targetProject }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      tool: string;
      result: { id: string };
      sources: Array<{ source: string; id: string }>;
    };
    assert.equal(body.tool, "project_context");
    assert.equal(body.result.id, targetProject);
    assert.deepEqual(body.sources, [{ source: "projects", id: targetProject }]);
    assert.equal(body.sources.some((source) => source.id === otherProject), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});