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
  pettyCashExceptionsTable,
  pettyCashFundsTable,
  pettyCashFundEventsTable,
  pettyCashRequestsTable,
  pettyCashPolicyVersionsTable,
  rabBaselinesTable,
  rabItemsTable,
  projectCostCodesTable,
  actualCostAllocationsTable,
  userRolesTable,
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
const fundId = `fund-${runId}`;
const baselineId = `baseline-${runId}`;
const costCodeId = `code-${runId}`;
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
    await db.delete(actualCostAllocationsTable).where(inArray(actualCostAllocationsTable.sourceId,
      (await db.select({ id: pettyCashExpensesTable.id }).from(pettyCashExpensesTable).where(inArray(pettyCashExpensesTable.requestId, requestIds))).map(row => row.id)));
    await db.delete(pettyCashExceptionsTable).where(inArray(pettyCashExceptionsTable.requestId, requestIds));
    await db.delete(pettyCashExpensesTable).where(inArray(pettyCashExpensesTable.requestId, requestIds));
    await db.delete(pettyCashRequestsTable).where(inArray(pettyCashRequestsTable.id, requestIds));
  }
  const funds = await db.select({ id: pettyCashFundsTable.id }).from(pettyCashFundsTable).where(eq(pettyCashFundsTable.projectId, projectId));
  if (funds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, funds.map(fund => fund.id)));
    await db.delete(pettyCashFundEventsTable).where(inArray(pettyCashFundEventsTable.fundId, funds.map(fund => fund.id)));
    await db.delete(pettyCashFundsTable).where(inArray(pettyCashFundsTable.id, funds.map(fund => fund.id)));
  }
  await db.delete(rabItemsTable).where(eq(rabItemsTable.baselineId, baselineId));
  await db.delete(projectCostCodesTable).where(eq(projectCostCodesTable.id, costCodeId));
  await db.delete(rabBaselinesTable).where(eq(rabBaselinesTable.id, baselineId));
  await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
  await db.delete(userRolesTable).where(eq(userRolesTable.userId, `finance-${runId}`));
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
    await db.insert(rabBaselinesTable).values({ id: baselineId, projectId, status: "DISETUJUI", version: 1 });
    await db.insert(projectCostCodesTable).values({ id: costCodeId, projectId, code: "SITE-GENERAL", name: "Site general" });
    await db.insert(rabItemsTable).values({ id: `rab-${runId}`, baselineId, costCodeId, code: "SITE-GENERAL", name: "Site general", category: "UMUM", budget: 10000000, committed: 0, actual: 0 });
    await db.insert(pettyCashFundsTable).values({ id: fundId, projectId, location: "Gudang utama", custodianUserId: `finance-${runId}`, custodianName: "Finance", bookBalance: 1000000 });
    await db.insert(userRolesTable).values({ userId: `finance-${runId}`, role: "FINANCE", displayName: `FINANCE ${runId.slice(-4)}` });
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
    const verifier = await startServer(access("FINANCE", `verifier-${runId}`));
    const evaluator = await startServer(access("DIRECTOR", `evaluator-${runId}`));
    const selfApprover = await startServer(access("DIRECTOR", `self-${runId}`));
    try {
      const newFund = await call(disburser.baseUrl, "/petty-cash/funds", "POST", {
        projectId, location: "Workshop", custodianUserId: `finance-${runId}`, custodianName: `FINANCE ${runId.slice(-4)}`,
      });
      assert.equal(newFund.response.status, 201, JSON.stringify(newFund.body));
      const replenished = await call(disburser.baseUrl, `/petty-cash/funds/${newFund.body.id}/replenish`, "POST", {
        amount: 200_000, reference: "TOPUP-001",
      });
      assert.equal(replenished.response.status, 200);
      assert.equal(replenished.body.bookBalance, 200_000);
      const duplicateFund = await call(disburser.baseUrl, "/petty-cash/funds", "POST", {
        projectId, location: "Workshop", custodianUserId: `finance-${runId}`, custodianName: `FINANCE ${runId.slice(-4)}`,
      });
      assert.equal(duplicateFund.response.status, 409);
      const selfRequest = await call(selfApprover.baseUrl, "/petty-cash", "POST", {
        projectId,
        fundId,
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
        fundId,
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
        returnReference: "RET-001",
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
        returnReference: "RET-001",
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
      const verified = await call(verifier.baseUrl, `/petty-cash/${requestId}/verify`, "POST");
      assert.equal(verified.response.status, 200, JSON.stringify(verified.body));

      const deniedDisburserReconciliation = await call(disburser.baseUrl, `/petty-cash/${requestId}/reconcile`, "POST", {
        physicalCashAmount: 600_000,
        note: "Tidak boleh lolos",
      });
      assert.equal(deniedDisburserReconciliation.response.status, 409);

      const reconciled = await call(reconciler.baseUrl, `/petty-cash/${requestId}/reconcile`, "POST", {
        physicalCashAmount: 600_000,
        note: "Kas fisik dan bukti sesuai",
      });
      assert.equal(reconciled.response.status, 200);
      assert.equal(reconciled.body.status, "DIREKONSILIASI");

      const [stored] = await db.select().from(pettyCashRequestsTable)
        .where(eq(pettyCashRequestsTable.id, requestId));
      assert.equal(stored.spentAmount, 400_000);
      assert.equal(stored.returnedAmount, 50_000);
      assert.equal(stored.physicalCashAmount, 600_000);
      const [actual] = await db.select().from(actualCostAllocationsTable)
        .where(eq(actualCostAllocationsTable.sourceType, "PETTY_CASH"));
      assert.ok(actual, "settlement posts actual cost once");

      const second = await call(requester.baseUrl, "/petty-cash", "POST", {
        projectId, fundId, purpose: "Transport barang lokasi", costCode: "SITE-GENERAL",
        requestedAmount: 200_000, requestedAt: "2026-09-20",
      });
      assert.equal(second.response.status, 201);
      const secondId = String(second.body.id);
      assert.equal((await call(approver.baseUrl, `/petty-cash/${secondId}/decision`, "POST", {
        decision: "APPROVE", approvedAmount: 200_000, note: "Sesuai RAB",
      })).response.status, 200);
      assert.equal((await call(disburser.baseUrl, `/petty-cash/${secondId}/disburse`, "POST", {
        amount: 200_000, reference: "CASH-002",
      })).response.status, 200);
      const missing = await call(requester.baseUrl, `/petty-cash/${secondId}/settle`, "POST", {
        returnedAmount: 50_000, returnReference: "RETURN-002",
        expenses: [{ expenseDate: "2026-09-20", description: "Transport", amount: 150_000 }],
      });
      assert.equal(missing.response.status, 200, JSON.stringify(missing.body));
      const exception = (missing.body.exceptions as { expenseId: string; ownerUserId: string; dueAt: string; status: string }[])[0];
      assert.equal(exception.ownerUserId, `site-${runId}`);
      assert.equal(exception.status, "OPEN");
      assert.ok(exception.dueAt);
      assert.equal((await call(verifier.baseUrl, `/petty-cash/${secondId}/verify`, "POST")).response.status, 409);
      assert.equal((await call(requester.baseUrl, `/petty-cash/${secondId}/evidence`, "POST", {
        expenseId: exception.expenseId, receiptReference: "RECEIPT-002",
      })).response.status, 200);
      assert.equal((await call(verifier.baseUrl, `/petty-cash/${secondId}/verify`, "POST")).response.status, 200);
      const mismatch = await call(reconciler.baseUrl, `/petty-cash/${secondId}/reconcile`, "POST", {
        physicalCashAmount: 1, note: "Selisih saat hitung",
      });
      assert.equal(mismatch.response.status, 409);
      assert.equal((await call(reconciler.baseUrl, `/petty-cash/${secondId}/reconcile`, "POST", {
        physicalCashAmount: 450_000, note: "Sesuai hitung",
      })).response.status, 200);
      assert.equal((await call(approver.baseUrl, `/petty-cash/${secondId}/evaluate`, "POST", { note: "Evaluasi" })).response.status, 409);
      assert.equal((await call(evaluator.baseUrl, `/petty-cash/${secondId}/evaluate`, "POST", { note: "Diterima" })).response.status, 200);
      const [fund] = await db.select().from(pettyCashFundsTable).where(eq(pettyCashFundsTable.id, fundId));
      assert.equal(fund.bookBalance, 450_000);
      const mismatchAudits = await db.select().from(auditLogsTable).where(eq(auditLogsTable.entityId, secondId));
      assert.ok(mismatchAudits.some(audit => audit.action === "SELISIH_REKONSILIASI"));

      const large = await call(requester.baseUrl, "/petty-cash", "POST", {
        projectId, fundId, purpose: "Peralatan lapangan", costCode: "SITE-GENERAL",
        requestedAmount: 5_000_000, requestedAt: "2026-09-20",
      });
      assert.equal(large.response.status, 201);
      assert.equal((await call(approver.baseUrl, `/petty-cash/${large.body.id}/decision`, "POST", {
        decision: "APPROVE", approvedAmount: 5_000_000, note: "Di atas matriks",
      })).response.status, 403);
      assert.equal((await call(reconciler.baseUrl, `/petty-cash/${large.body.id}/decision`, "POST", {
        decision: "APPROVE", approvedAmount: 5_000_000, note: "Direktur menyetujui",
      })).response.status, 200);
      assert.equal((await call(disburser.baseUrl, `/petty-cash/${large.body.id}/disburse`, "POST", {
        amount: 5_000_000, reference: "SALDO-TIDAK-CUKUP",
      })).response.status, 409);

      const excessBudget = await call(requester.baseUrl, "/petty-cash", "POST", {
        projectId, fundId, purpose: "Tambahan peralatan", costCode: "SITE-GENERAL",
        requestedAmount: 5_000_000, requestedAt: "2026-09-20",
      });
      assert.equal(excessBudget.response.status, 201);
      assert.equal((await call(reconciler.baseUrl, `/petty-cash/${excessBudget.body.id}/decision`, "POST", {
        decision: "APPROVE", approvedAmount: 5_000_000, note: "Melebihi sisa RAB",
      })).response.status, 422);

      // Rows from the original schema have no fund_id. They must finish without
      // assigning fictitious balances to newly-created location funds.
      const [policy] = await db.select().from(pettyCashPolicyVersionsTable).limit(1);
      const legacyBase = {
        projectId, projectCode, projectName: "Petty Cash Regression Project",
        requesterUserId: `site-${runId}`, requesterName: "Legacy requester",
        purpose: "Transaksi sebelum migrasi", costCode: "LEGACY-CODE",
        requestedAt: "2026-09-20", evidenceDueAt: "2026-09-23",
        policyVersionId: policy.id, policyVersion: policy.version,
      };
      const legacyApprovedId = `legacy-approved-${runId}`;
      await db.insert(pettyCashRequestsTable).values({
        ...legacyBase, id: legacyApprovedId, requestedAmount: 300_000,
        approvedAmount: 300_000, status: "DISETUJUI",
        approverUserId: `pm-${runId}`, approverName: "Legacy approver",
      });
      assert.equal((await call(disburser.baseUrl, `/petty-cash/${legacyApprovedId}/disburse`, "POST", {
        amount: 300_000, reference: "LEGACY-CASH",
      })).response.status, 200);
      assert.equal((await call(requester.baseUrl, `/petty-cash/${legacyApprovedId}/settle`, "POST", {
        returnedAmount: 50_000, returnReference: "LEGACY-RETURN",
        expenses: [{ expenseDate: "2026-09-20", description: "Biaya lama", amount: 250_000, receiptReference: "LEGACY-RECEIPT" }],
      })).response.status, 200);
      assert.equal((await call(reconciler.baseUrl, `/petty-cash/${legacyApprovedId}/reconcile`, "POST", {
        physicalCashAmount: 50_000, note: "Sisa transaksi lama sesuai",
      })).response.status, 200);
      const legacySettledId = `legacy-settled-${runId}`;
      await db.insert(pettyCashRequestsTable).values({
        ...legacyBase, id: legacySettledId, requestedAmount: 100_000, approvedAmount: 100_000,
        disbursedAmount: 100_000, spentAmount: 80_000, returnedAmount: 20_000,
        status: "DIPERTANGGUNGJAWABKAN", approverUserId: `pm-${runId}`,
        disburserUserId: `finance-${runId}`,
      });
      await db.insert(pettyCashExpensesTable).values({
        id: `legacy-expense-${runId}`, requestId: legacySettledId,
        expenseDate: "2026-09-20", description: "Bukti lama", amount: 80_000, receiptReference: "LEGACY-002",
      });
      assert.equal((await call(reconciler.baseUrl, `/petty-cash/${legacySettledId}/reconcile`, "POST", {
        physicalCashAmount: 20_000, note: "Sisa lama sesuai",
      })).response.status, 200);
      const [unaffectedFund] = await db.select().from(pettyCashFundsTable).where(eq(pettyCashFundsTable.id, fundId));
      assert.equal(unaffectedFund.bookBalance, 450_000);
    } finally {
      await Promise.all([requester.close(), approver.close(), disburser.close(), reconciler.close(), verifier.close(), evaluator.close(), selfApprover.close()]);
    }
  }, suiteName, statementTimeoutMs);
});