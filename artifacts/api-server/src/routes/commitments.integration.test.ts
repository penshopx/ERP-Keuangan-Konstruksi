import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { after, before, test } from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  actualCostAllocationsTable, auditLogsTable, commitmentEventsTable, commitmentTable, db, pool,
  projectCostCodesTable, projectsTable, rabBaselinesTable, rabItemsTable,
} from "@workspace/db";
import { createApiRouter } from "./index";
import type { AccessContext } from "../middlewares/access";
import {
  defaultDatabaseSuiteStatementTimeoutMs,
  runDatabaseSuiteOperation,
  setDatabaseSuitePoolStatementTimeout,
} from "../testing/database-suite-lock";

const suiteName = "Commitment integration";
const databaseTimeoutMs = defaultDatabaseSuiteStatementTimeoutMs;
setDatabaseSuitePoolStatementTimeout(suiteName, databaseTimeoutMs);
const runId = randomUUID();
const access: AccessContext = {
  userId: `commitment-test-${runId}`,
  displayName: "Commitment Test",
  role: "DIRECTOR",
  assignedProjectIds: [],
  permissions: ["commitments:approve", "commitments:post", "commitments:write", "commitments:view"],
};
let lockClient: { query: (text: string) => Promise<unknown>; release: () => void };

function appFor(testAccess = access) {
  const app = express();
  app.use(express.json());
  const accessMiddleware = (req: express.Request, _res: express.Response, next: express.NextFunction) => { req.access = testAccess; next(); };
  app.use("/api", createApiRouter(accessMiddleware));
  return app;
}

async function json(base: string, path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const raw = await response.text();
  let body: Record<string, any>;
  try { body = JSON.parse(raw) as Record<string, any>; } catch { throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}: ${raw.slice(0, 500)}`); }
  return { response, body };
}

let projectId = "";
let baselineId = "";
let code1 = "";
let code2 = "";
let item1 = "";
let item2 = "";
let foreignProjectId = "";
let foreignCode = "";
let line1 = "";
let line2 = "";
let commitmentId = "";

before(async () => {
  await runDatabaseSuiteOperation(async () => {
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock(hashtext('commitment-integration-suite'))");
  projectId = `commitment-project-${runId}`;
  baselineId = `commitment-baseline-${runId}`;
  code1 = `commitment-code-1-${runId}`;
  code2 = `commitment-code-2-${runId}`;
  item1 = `item1-${runId}`;
  item2 = `item2-${runId}`;
  foreignProjectId = `foreign-commitment-project-${runId}`;
  foreignCode = `foreign-commitment-code-${runId}`;
  await db.insert(projectsTable).values({
    id: projectId, code: projectId, name: "Commitment integration", owner: "Test",
    contractValue: 1_000_000, budget: 300_000, actualCost: 0, progress: 0,
    status: "BERJALAN", health: "SEHAT", endDate: "2099-12-31", wbsCount: 2,
  });
  await db.insert(projectsTable).values({
    id: foreignProjectId, code: foreignProjectId, name: "Foreign commitment project", owner: "Test",
    contractValue: 1_000_000, budget: 100_000, actualCost: 0, progress: 0,
    status: "BERJALAN", health: "SEHAT", endDate: "2099-12-31", wbsCount: 0,
  });
  await db.insert(rabBaselinesTable).values({ id: baselineId, projectId, version: 1, status: "DISETUJUI" });
  await db.insert(projectCostCodesTable).values([
    { id: code1, projectId, code: "01", name: "Pekerjaan 01" },
    { id: code2, projectId, code: "02", name: "Pekerjaan 02" },
  ]);
  await db.insert(projectCostCodesTable).values({
    id: foreignCode, projectId: foreignProjectId, code: "FOREIGN", name: "Foreign cost code",
  });
    await db.insert(rabItemsTable).values([
    { id: item1, baselineId, costCodeId: code1, code: "01", name: "Pekerjaan 01", category: "MATERIAL", parentCode: null, level: 1, unit: "ls", quantityBasisPoints: 100, unitPrice: 150_000, materialCost: 150_000, laborCost: 0, equipmentCost: 0, budget: 150_000, committed: 0, actual: 0 },
    { id: item2, baselineId, costCodeId: code2, code: "02", name: "Pekerjaan 02", category: "MATERIAL", parentCode: null, level: 1, unit: "ls", quantityBasisPoints: 100, unitPrice: 150_000, materialCost: 150_000, laborCost: 0, equipmentCost: 0, budget: 150_000, committed: 0, actual: 0 },
    ]);
  }, suiteName, databaseTimeoutMs);
});

after(async () => {
  await runDatabaseSuiteOperation(async () => {
    try {
    await db.delete(auditLogsTable).where(eq(auditLogsTable.actorUserId, access.userId));
    const commitments = await db.select({ id: commitmentTable.id }).from(commitmentTable).where(eq(commitmentTable.projectId, projectId));
    if (commitments.length) {
      await db.delete(commitmentEventsTable).where(inArray(commitmentEventsTable.commitmentId, commitments.map((row) => row.id)));
      await db.delete(actualCostAllocationsTable).where(inArray(actualCostAllocationsTable.commitmentId, commitments.map((row) => row.id)));
      await db.delete(commitmentTable).where(inArray(commitmentTable.id, commitments.map((row) => row.id)));
    }
    await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
    await db.delete(projectsTable).where(eq(projectsTable.id, foreignProjectId));
    } finally {
      try {
        await lockClient?.query("SELECT pg_advisory_unlock(hashtext('commitment-integration-suite'))");
      } finally {
        lockClient?.release();
        await pool.end();
      }
    }
  }, suiteName, databaseTimeoutMs);
});

test("commitment ledger persists, scopes, versions, and reconciles without double count", async () => {
  await runDatabaseSuiteOperation(async () => {
  const server = appFor().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  try {
    const created = await json(base, `/projects/${projectId}/commitments`, {
      method: "POST",
      body: JSON.stringify({
        baselineId, documentType: "PO", documentNumber: `PO-${runId}`, vendorName: "Vendor",
        lines: [
          { costCodeId: code1, description: "Line one", amount: 100_000 },
          { costCodeId: code2, description: "Line two", amount: 50_000 },
        ],
      }),
    });
    assert.equal(created.response.status, 201);
    commitmentId = String(created.body.id);
    line1 = String(created.body.lines[0].id);
    line2 = String(created.body.lines[1].id);
    const stored = await db.select().from(commitmentTable).where(eq(commitmentTable.id, commitmentId));
    assert.equal(stored[0]?.totalAmount, 150_000);
    assert.equal((await db.select().from(commitmentEventsTable).where(eq(commitmentEventsTable.commitmentId, commitmentId))).length, 1);
    const invalidCreateItem = await json(base, `/projects/${projectId}/commitments`, {
      method: "POST",
      body: JSON.stringify({
        baselineId, documentType: "PO", documentNumber: `PO-INVALID-ITEM-${runId}`, vendorName: "Vendor",
        lines: [{ costCodeId: code1, rabItemId: item2, description: "Mismatch", amount: 1_000 }],
      }),
    });
    assert.equal(invalidCreateItem.response.status, 400);
    const invalidCreateProject = await json(base, `/projects/${projectId}/commitments`, {
      method: "POST",
      body: JSON.stringify({
        baselineId, documentType: "PO", documentNumber: `PO-INVALID-PROJECT-${runId}`, vendorName: "Vendor",
        lines: [{ costCodeId: foreignCode, description: "Foreign", amount: 1_000 }],
      }),
    });
    assert.equal(invalidCreateProject.response.status, 400);

    await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "SUBMIT" }) });
    const selfApprove = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "APPROVE" }) });
    assert.equal(selfApprove.response.status, 403);
    const approver = { ...access, userId: `other-${runId}`, displayName: "Other" };
    const approvedServer = appFor(approver).listen(0);
    await new Promise<void>((resolve) => approvedServer.once("listening", () => resolve()));
    const approvedBase = `http://127.0.0.1:${(approvedServer.address() as { port: number }).port}/api`;
    const approved = await json(approvedBase, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "APPROVE" }) });
    assert.equal(approved.response.status, 200);
    await new Promise<void>((resolve, reject) => approvedServer.close((error) => error ? reject(error) : resolve()));

    const foreignAmendment = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, {
      method: "POST",
      body: JSON.stringify({ action: "AMEND", lines: [{ costCodeId: foreignCode, description: "Foreign", amount: 10_000 }] }),
    });
    assert.equal(foreignAmendment.response.status, 400);
    const mismatchedItemAmendment = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, {
      method: "POST",
      body: JSON.stringify({ action: "AMEND", lines: [{ costCodeId: code1, rabItemId: item2, description: "Mismatch", amount: 10_000 }] }),
    });
    assert.equal(mismatchedItemAmendment.response.status, 400);
    const missingIdempotencyKey = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, {
      method: "POST",
      body: JSON.stringify({ action: "INVOICE", lineId: line1, amount: 40_000 }),
    });
    assert.equal(missingIdempotencyKey.response.status, 400);

    let result = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "INVOICE", lineId: line1, amount: 40_000, idempotencyKey: "invoice-1" }) });
    assert.equal(result.response.status, 200);
    result = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "INVOICE", lineId: line1, amount: 40_000, idempotencyKey: "invoice-1" }) });
    assert.equal(result.response.status, 200);
    result = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "INVOICE", lineId: line1, amount: 40_000, idempotencyKey: "invoice-same-amount-but-distinct" }) });
    assert.equal(result.response.status, 200);
    const summary = await json(base, `/projects/${projectId}/rab`);
    assert.equal(summary.body.committed, 70_000);
    assert.equal(summary.body.actual, 80_000);
    assert.equal(summary.body.availableBudget, 150_000);
    const over = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "INVOICE", lineId: line1, amount: 20_001, idempotencyKey: "invoice-over" }) });
    assert.equal(over.response.status, 400);
    const receive = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "RECEIVE", lineId: line2, amount: 50_000, idempotencyKey: "receive-2" }) });
    assert.equal(receive.response.status, 200);
    const afterReceive = await json(base, `/projects/${projectId}/rab`);
    assert.equal(afterReceive.body.committed, 70_000);
    assert.equal(afterReceive.body.actual, 80_000);
    await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "INVOICE", lineId: line1, amount: 20_000, idempotencyKey: "invoice-2" }) });
    const closed = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "INVOICE", lineId: line2, amount: 50_000, idempotencyKey: "invoice-3" }) });
    assert.equal(closed.body.status, "CLOSED");
    assert.equal((await json(base, `/projects/${projectId}/commitments`)).body[0].status, "CLOSED");

    const amendment = await json(base, `/projects/${projectId}/commitments/${commitmentId}/transition`, { method: "POST", body: JSON.stringify({ action: "AMEND", lines: [{ costCodeId: code1, description: "Changed", amount: 10_000 }] }) });
    assert.equal(amendment.response.status, 409);

    const second = await json(base, `/projects/${projectId}/commitments`, {
      method: "POST",
      body: JSON.stringify({
        baselineId, documentType: "SPK", documentNumber: `SPK-${runId}`, vendorName: "Vendor 2",
        lines: [{ costCodeId: code1, rabItemId: item1, description: "Same key on another commitment", amount: 10_000 }],
      }),
    });
    assert.equal(second.response.status, 201);
    const secondId = String(second.body.id);
    const secondLineId = String(second.body.lines[0].id);
    await json(base, `/projects/${projectId}/commitments/${secondId}/transition`, {
      method: "POST", body: JSON.stringify({ action: "SUBMIT" }),
    });
    const secondApproverServer = appFor({ ...access, userId: `second-approver-${runId}` }).listen(0);
    await new Promise<void>((resolve) => secondApproverServer.once("listening", () => resolve()));
    const secondApproverBase = `http://127.0.0.1:${(secondApproverServer.address() as { port: number }).port}/api`;
    const secondApproved = await json(secondApproverBase, `/projects/${projectId}/commitments/${secondId}/transition`, {
      method: "POST", body: JSON.stringify({ action: "APPROVE" }),
    });
    assert.equal(secondApproved.response.status, 200);
    await new Promise<void>((resolve, reject) => secondApproverServer.close((error) => error ? reject(error) : resolve()));

    const procurement: AccessContext = {
      userId: `procurement-${runId}`,
      displayName: "Procurement",
      role: "PROCUREMENT",
      assignedProjectIds: [],
      permissions: ["commitments:view", "commitments:write"],
    };
    const procurementServer = appFor(procurement).listen(0);
    await new Promise<void>((resolve) => procurementServer.once("listening", () => resolve()));
    const procurementBase = `http://127.0.0.1:${(procurementServer.address() as { port: number }).port}/api`;
    const forbiddenReceipt = await json(procurementBase, `/projects/${projectId}/commitments/${secondId}/transition`, {
      method: "POST", body: JSON.stringify({ action: "RECEIVE", lineId: secondLineId, amount: 1_000, idempotencyKey: "procurement-receive" }),
    });
    assert.equal(forbiddenReceipt.response.status, 403);
    const forbiddenCancel = await json(procurementBase, `/projects/${projectId}/commitments/${secondId}/transition`, {
      method: "POST", body: JSON.stringify({ action: "CANCEL" }),
    });
    assert.equal(forbiddenCancel.response.status, 403);

    const pending = await json(base, `/projects/${projectId}/commitments`, {
      method: "POST",
      body: JSON.stringify({
        baselineId, documentType: "PO", documentNumber: `PO-PENDING-${runId}`, vendorName: "Vendor 3",
        lines: [{ costCodeId: code2, rabItemId: item2, description: "Pending", amount: 1_000 }],
      }),
    });
    const pendingId = String(pending.body.id);
    await json(base, `/projects/${projectId}/commitments/${pendingId}/transition`, {
      method: "POST", body: JSON.stringify({ action: "SUBMIT" }),
    });
    const forbiddenReject = await json(procurementBase, `/projects/${projectId}/commitments/${pendingId}/transition`, {
      method: "POST", body: JSON.stringify({ action: "REJECT" }),
    });
    assert.equal(forbiddenReject.response.status, 403);
    await new Promise<void>((resolve, reject) => procurementServer.close((error) => error ? reject(error) : resolve()));

    const reusedKeyAcrossCommitments = await json(base, `/projects/${projectId}/commitments/${secondId}/transition`, {
      method: "POST",
      body: JSON.stringify({ action: "INVOICE", lineId: secondLineId, amount: 10_000, idempotencyKey: "invoice-1" }),
    });
    assert.equal(reusedKeyAcrossCommitments.response.status, 200);
    const afterReusedKey = await json(base, `/projects/${projectId}/rab`);
    assert.equal(afterReusedKey.body.actual, 160_000);
    assert.equal(afterReusedKey.body.availableBudget, 140_000);
    const scoped = await json(base, `/projects/not-${projectId}/commitments`);
    assert.equal(scoped.response.status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  }, suiteName, databaseTimeoutMs);
});