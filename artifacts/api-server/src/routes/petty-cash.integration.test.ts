import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  pettyCashExpensesTable,
  pettyCashRequestsTable,
  pool,
  projectsTable,
} from "@workspace/db";
import type { AccessContext } from "../middlewares/access";
import {
  acquirePersistenceDatabaseSuiteLock,
  defaultDatabaseSuiteStatementTimeoutMs,
  releasePersistenceDatabaseSuiteLock,
  runDatabaseSuiteOperation,
  setDatabaseSuitePoolStatementTimeout,
  type DatabaseSuiteLockClient,
} from "../testing/database-suite-lock";
import { createApiRouter } from "./index";

const runId = randomUUID();
const projectId = `petty-cash-project-${runId}`;
const projectCode = `PC-${runId.slice(0, 8)}`;
const suiteName = "Petty cash integration suite";
const statementTimeoutMs = defaultDatabaseSuiteStatementTimeoutMs;
let databaseSuiteLockClient: DatabaseSuiteLockClient | undefined;

const access = (role: AccessContext["role"], userId: string, assignedProjectIds: string[] = []): AccessContext => ({
  role,
  userId,
  displayName: `${role} ${userId.slice(-4)}`,
  assignedProjectIds,
  permissions: [],
});

async function startServer(testAccess: AccessContext) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter((req, _res, next) => {
    req.access = testAccess;
    next();
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function call(baseUrl: string, path: string, method: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

async function cleanup() {
  const requests = await db.select({ id: pettyCashRequestsTable.id })
    .from(pettyCashRequestsTable)
    .where(eq(pettyCashRequestsTable.projectId, projectId));
  const requestIds = requests.map(({ id }) => id);
  if (requestIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, requestIds));
    await db.delete(pettyCashExpensesTable).where(inArray(pettyCashExpensesTable.requestId, requestIds));
    await db.delete(pettyCashRequestsTable).where(inArray(pettyCashRequestsTable.id, requestIds));
  }
  await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
}

before(async () => {
  setDatabaseSuitePoolStatementTimeout(suiteName, statementTimeoutMs);
  await runDatabaseSuiteOperation(async () => {
    databaseSuiteLockClient = await acquirePersistenceDatabaseSuiteLock(120_000);
    await cleanup();
    await db.insert(projectsTable).values({
      id: projectId,
      code: projectCode,
      name: "Petty Cash Regression Project",
      owner: "Integration Test",
      contractValue: 1_000_000_000,
      budget: 800_000_000,
      actualCost: 0,
      progress: 10,
      status: "BERJALAN",
      health: "SEHAT",
      endDate: "2027-12-31",
    });
  }, suiteName, statementTimeoutMs);
});

after(async () => {
  try {
    if (databaseSuiteLockClient) await cleanup();
  } finally {
    if (databaseSuiteLockClient) await releasePersistenceDatabaseSuiteLock(databaseSuiteLockClient);
    await pool.end();
  }
});

test("petty cash enforces segregation, evidence balance, and reconciliation", async () => {
  await runDatabaseSuiteOperation(async () => {
    const requester = await startServer(access("SITE_MANAGER", `site-${runId}`));
    const approver = await startServer(access("PROJECT_MANAGER", `pm-${runId}`, [projectId]));
    const disburser = await startServer(access("FINANCE", `finance-${runId}`));
    const reconciler = await startServer(access("DIRECTOR", `director-${runId}`));
    const selfApprover = await startServer(access("DIRECTOR", `self-${runId}`));
    try {
      const selfRequest = await call(selfApprover.baseUrl, "/petty-cash", "POST", {
        projectId,
        purpose: "Permintaan untuk uji self approval",
        costCode: "SITE-GENERAL",
        requestedAmount: 100_000,
        requestedAt: "2026-09-20",
      });
      assert.equal(selfRequest.response.status, 201);
      const deniedSelfApproval = await call(
        selfApprover.baseUrl,
        `/petty-cash/${selfRequest.body.id}/decision`,
        "POST",
        { decision: "APPROVE", approvedAmount: 100_000, note: "Tidak boleh lolos" },
      );
      assert.equal(deniedSelfApproval.response.status, 409);

      const created = await call(requester.baseUrl, "/petty-cash", "POST", {
        projectId,
        purpose: "Pembelian kebutuhan harian lokasi",
        costCode: "SITE-GENERAL",
        requestedAmount: 500_000,
        requestedAt: "2026-09-20",
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.body.status, "DIAJUKAN");
      assert.equal(created.body.policyVersion, "SOP-KAS-KECIL-INITIAL");
      const requestId = String(created.body.id);

      const earlyDisbursement = await call(disburser.baseUrl, `/petty-cash/${requestId}/disburse`, "POST", {
        amount: 500_000,
        reference: "CASH-TOO-EARLY",
      });
      assert.equal(earlyDisbursement.response.status, 409);

      const approved = await call(approver.baseUrl, `/petty-cash/${requestId}/decision`, "POST", {
        decision: "APPROVE",
        approvedAmount: 450_000,
        note: "Sesuai kebutuhan proyek",
      });
      assert.equal(approved.response.status, 200);
      assert.equal(approved.body.status, "DISETUJUI");

      const disbursed = await call(disburser.baseUrl, `/petty-cash/${requestId}/disburse`, "POST", {
        amount: 450_000,
        reference: "BANK-TEST-001",
      });
      assert.equal(disbursed.response.status, 200);
      assert.equal(disbursed.body.status, "DICAIRKAN");

      const invalidSettlement = await call(requester.baseUrl, `/petty-cash/${requestId}/settle`, "POST", {
        returnedAmount: 10_000,
        expenses: [{
          expenseDate: "2026-09-20",
          description: "Bahan habis pakai",
          amount: 400_000,
          receiptReference: "RECEIPT-001",
        }],
      });
      assert.equal(invalidSettlement.response.status, 400);

      const settled = await call(requester.baseUrl, `/petty-cash/${requestId}/settle`, "POST", {
        returnedAmount: 50_000,
        expenses: [{
          expenseDate: "2026-09-20",
          description: "Bahan habis pakai",
          amount: 400_000,
          receiptReference: "RECEIPT-001",
        }],
      });
      assert.equal(settled.response.status, 200);
      assert.equal(settled.body.status, "DIPERTANGGUNGJAWABKAN");
      assert.equal((settled.body.expenses as unknown[]).length, 1);

      const deniedDisburserReconciliation = await call(disburser.baseUrl, `/petty-cash/${requestId}/reconcile`, "POST", {
        physicalCashAmount: 50_000,
        note: "Tidak boleh lolos",
      });
      assert.equal(deniedDisburserReconciliation.response.status, 409);

      const reconciled = await call(reconciler.baseUrl, `/petty-cash/${requestId}/reconcile`, "POST", {
        physicalCashAmount: 50_000,
        note: "Kas fisik dan bukti sesuai",
      });
      assert.equal(reconciled.response.status, 200);
      assert.equal(reconciled.body.status, "DIREKONSILIASI");

      const [stored] = await db.select().from(pettyCashRequestsTable)
        .where(eq(pettyCashRequestsTable.id, requestId));
      assert.equal(stored.spentAmount, 400_000);
      assert.equal(stored.returnedAmount, 50_000);
      assert.equal(stored.physicalCashAmount, 50_000);
    } finally {
      await Promise.all([requester.close(), approver.close(), disburser.close(), reconciler.close(), selfApprover.close()]);
    }
  }, suiteName, statementTimeoutMs);
});