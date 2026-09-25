import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  actualCostAllocationsTable, auditLogsTable, commitmentEventsTable, commitmentLinesTable,
  commitmentTable, db, pool, projectCostCodesTable, projectsTable, rabBaselinesTable,
  vendorInvoicesTable, vendorPaymentsTable,
} from "@workspace/db";
import { createApiRouter } from "./index";
import type { AccessContext } from "../middlewares/access";
import { defaultDatabaseSuiteStatementTimeoutMs, runDatabaseSuiteOperation, setDatabaseSuitePoolStatementTimeout } from "../testing/database-suite-lock";

const suite = "Vendor payment matching integration";
const timeout = defaultDatabaseSuiteStatementTimeoutMs;
setDatabaseSuitePoolStatementTimeout(suite, timeout);
const id = randomUUID();
const projectId = `vendor-test-${id}`;
const baselineId = `vendor-baseline-${id}`;
const costCodeId = `vendor-code-${id}`;
const commitmentId = `vendor-commitment-${id}`;
const lineId = `vendor-line-${id}`;
const receiptId = `vendor-receipt-${id}`;
let client: { query: (text: string) => Promise<unknown>; release: () => void };
const app = express();
app.use(express.json());
app.use("/api", createApiRouter((req, _res, next) => {
  const role = String(req.header("x-role") ?? "PROCUREMENT") as AccessContext["role"];
  req.access = {
    userId: `vendor-${role}-${id}`, role, displayName: role, assignedProjectIds: [projectId],
    permissions: role === "PROCUREMENT" ? ["commitments:view", "commitments:write"]
      : role === "PROJECT_MANAGER" ? ["commitments:view", "commitments:approve"]
      : role === "DIRECTOR" ? ["commitments:view", "commitments:approve", "commitments:write", "tax-rules:manage"]
      : ["commitments:view", "commitments:approve", "commitments:write"],
  };
  next();
}));
let server: ReturnType<typeof app.listen>;
let base: string;
async function send(role: string, path: string, data?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-role": role },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
before(async () => {
  await runDatabaseSuiteOperation(async () => {
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtext('vendor-payment-test'))");
    await db.insert(projectsTable).values({ id: projectId, code: projectId, name: "Vendor test", owner: "Test", contractValue: 10000, budget: 10000, actualCost: 0, progress: 0, status: "BERJALAN", health: "SEHAT", endDate: "2099-12-31", wbsCount: 1 });
    await db.insert(rabBaselinesTable).values({ id: baselineId, projectId, version: 1, status: "DISETUJUI" });
    await db.insert(projectCostCodesTable).values({ id: costCodeId, projectId, code: "01", name: "Vendor test" });
    await db.insert(commitmentTable).values({ id: commitmentId, projectId, baselineId, documentType: "PO", documentNumber: id, vendorName: "Vendor A", status: "APPROVED", totalAmount: 1000, createdBy: "other" });
    await db.insert(commitmentLinesTable).values({ id: lineId, commitmentId, costCodeId, description: "10 units", amount: 1000, quantity: 10, receivedAmount: 600 });
    await db.insert(commitmentEventsTable).values({ id: receiptId, commitmentId, eventType: "RECEIVE", amount: 600, sourceId: id, actorUserId: "other", metadata: JSON.stringify({ lineId, note: "BA penerimaan 12" }) });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  }, suite, timeout);
});
after(async () => {
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  await runDatabaseSuiteOperation(async () => {
    try {
      const invoices = await db.select({ id: vendorInvoicesTable.id }).from(vendorInvoicesTable).where(eq(vendorInvoicesTable.projectId, projectId));
      const invoiceIds = invoices.map((row) => row.id);
      const payments = invoiceIds.length ? await db.select({ id: vendorPaymentsTable.id }).from(vendorPaymentsTable).where(inArray(vendorPaymentsTable.invoiceId, invoiceIds)) : [];
      const auditIds = [...invoiceIds, ...payments.map((row) => row.id)];
      if (auditIds.length) await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, auditIds));
      if (invoiceIds.length) await db.delete(vendorPaymentsTable).where(inArray(vendorPaymentsTable.invoiceId, invoiceIds));
      await db.delete(vendorInvoicesTable).where(eq(vendorInvoicesTable.projectId, projectId));
      await db.delete(actualCostAllocationsTable).where(eq(actualCostAllocationsTable.projectId, projectId));
      await db.delete(commitmentEventsTable).where(eq(commitmentEventsTable.commitmentId, commitmentId));
      await db.delete(commitmentLinesTable).where(eq(commitmentLinesTable.commitmentId, commitmentId));
      await db.delete(commitmentTable).where(eq(commitmentTable.id, commitmentId));
      await db.delete(projectCostCodesTable).where(eq(projectCostCodesTable.projectId, projectId));
      await db.delete(rabBaselinesTable).where(eq(rabBaselinesTable.id, baselineId));
      await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
    } finally {
      await client?.query("SELECT pg_advisory_unlock(hashtext('vendor-payment-test'))");
      client?.release();
      await pool.end();
    }
  }, suite, timeout);
});
let sqlInvoiceId = "";
test("matching, duplicate, four actors, partial payments, credits and audit", async () => {
  await runDatabaseSuiteOperation(async () => {
    const input = { commitmentId, lineId, invoiceNumber: `I-${id}`, quantity: 6, unitPrice: 100, tax: 0, retention: 0, total: 600, receiptEventIds: [receiptId], evidence: "Invoice PDF 12" };
    assert.equal((await send("PROCUREMENT", `/projects/${projectId}/vendor-receipts`)).body[0].id, receiptId);
    const mismatch = await send("PROCUREMENT", `/projects/${projectId}/vendor-invoices`, { ...input, invoiceNumber: `I-BAD-${id}`, quantity: 7, total: 700 });
    assert.equal(mismatch.status, 201);
    assert.equal(mismatch.body.status, "EXCEPTION");
    assert.equal((await send("PROCUREMENT", `/vendor-invoices/${mismatch.body.id}/payments`, { amount: 1, evidence: "No" })).status, 409);
    assert.equal((await send("DIRECTOR", `/vendor-invoices/${mismatch.body.id}/decision`, { action: "CANCEL", evidence: "Invoice salah sebelum review" })).body.status, "CANCELLED");
    assert.equal((await db.select().from(actualCostAllocationsTable).where(eq(actualCostAllocationsTable.projectId, projectId))).length, 0, "Pembatalan pra-review tidak membuat posting pembalik");
    assert.equal((await db.select().from(commitmentLinesTable).where(eq(commitmentLinesTable.id, lineId)))[0].invoicedAmount, 0);
    const created = await send("PROCUREMENT", `/projects/${projectId}/vendor-invoices`, input);
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "MATCHED");
    sqlInvoiceId = created.body.id;
    assert.equal((await send("PROCUREMENT", `/projects/${projectId}/vendor-invoices`, input)).status, 409);
    assert.equal((await send("PROCUREMENT", `/vendor-invoices/${sqlInvoiceId}/decision`, { action: "REVIEW", evidence: "Self" })).status, 403);
    assert.equal((await send("PROJECT_MANAGER", `/vendor-invoices/${sqlInvoiceId}/decision`, { action: "REVIEW", evidence: "Checked BA and PO" })).body.status, "REVIEWED");
    const poCancellation = await send("DIRECTOR", `/projects/${projectId}/commitments/${commitmentId}/transition`, { action: "CANCEL" });
    assert.equal(poCancellation.status, 409, "PO tidak boleh dibatalkan saat invoice yang direview masih aktif");
    assert.equal((await send("PROJECT_MANAGER", `/vendor-invoices/${sqlInvoiceId}/payments`, { amount: 1, evidence: "Self" })).status, 403);
    const requested = await send("PROCUREMENT", `/vendor-invoices/${sqlInvoiceId}/payments`, { amount: 400, evidence: "Request 400" });
    assert.equal(requested.status, 201);
    const credit = await send("PROCUREMENT", `/projects/${projectId}/vendor-invoices`, { ...input, invoiceNumber: `CN-${id}`, kind: "CREDIT_NOTE", originalInvoiceId: sqlInvoiceId, quantity: 1, total: 100, evidence: "Credit PDF" });
    assert.equal(credit.status, 201);
    assert.equal((await send("PROJECT_MANAGER", `/vendor-invoices/${credit.body.id}/decision`, { action: "REVIEW", evidence: "Credit checked" })).body.status, "REVIEWED");
    assert.equal((await send("PROCUREMENT", `/vendor-invoices/${sqlInvoiceId}/payments`, { amount: 101, evidence: "Too much" })).status, 409);
    assert.equal((await send("PROJECT_MANAGER", `/vendor-payments/${requested.body.id}/decision`, { action: "APPROVE", evidence: "Self reviewer" })).status, 403);
    assert.equal((await send("DIRECTOR", `/vendor-payments/${requested.body.id}/decision`, { action: "APPROVE", evidence: "Approved" })).body.status, "APPROVED");
    assert.equal((await send("DIRECTOR", `/vendor-payments/${requested.body.id}/decision`, { action: "RELEASE", evidence: "Self approver" })).status, 403);
    assert.equal((await send("FINANCE", `/vendor-payments/${requested.body.id}/decision`, { action: "RELEASE", evidence: "Bank transfer reference" })).body.status, "RELEASED");
    assert.equal((await send("DIRECTOR", `/vendor-invoices/${sqlInvoiceId}/decision`, { action: "CANCEL", evidence: "Too late" })).status, 409);
    assert.equal((await db.select().from(actualCostAllocationsTable).where(eq(actualCostAllocationsTable.projectId, projectId))).reduce((sum, row) => sum + row.amount, 0), 500);

    const raceInvoice = await send("PROCUREMENT", `/projects/${projectId}/vendor-invoices`, { ...input, invoiceNumber: `I-RACE-${id}`, quantity: 1, total: 100 });
    assert.equal(raceInvoice.body.status, "MATCHED");
    assert.equal((await send("PROJECT_MANAGER", `/vendor-invoices/${raceInvoice.body.id}/decision`, { action: "REVIEW", evidence: "BA checked" })).body.status, "REVIEWED");
    const blocker = await pool.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtext($1))", [commitmentId]);
    const waitForBlockedTransactions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await pool.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = hashtext($1)::oid",
          [commitmentId],
        );
        if (result.rows[0].waiting >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Expected ${count} queued commitment transactions`);
    };
    let cancellation: ReturnType<typeof send> | undefined;
    let request: ReturnType<typeof send> | undefined;
    try {
      cancellation = send("DIRECTOR", `/vendor-invoices/${raceInvoice.body.id}/decision`, { action: "CANCEL", evidence: "Cancelled before payment" });
      await waitForBlockedTransactions(1);
      request = send("PROCUREMENT", `/vendor-invoices/${raceInvoice.body.id}/payments`, { amount: 100, evidence: "Stale request" });
      await waitForBlockedTransactions(2);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [commitmentId]);
      blocker.release();
    }
    assert.equal((await cancellation).status, 200);
    assert.equal((await request).status, 409, "Permintaan yang antre harus membaca ulang status invoice setelah pembatalan");
    assert.equal((await db.select().from(vendorPaymentsTable).where(eq(vendorPaymentsTable.invoiceId, raceInvoice.body.id))).length, 0);

    const releaseInvoice = await send("PROCUREMENT", `/projects/${projectId}/vendor-invoices`, { ...input, invoiceNumber: `I-RELEASE-${id}`, quantity: 1, total: 100 });
    assert.equal(releaseInvoice.body.status, "MATCHED");
    assert.equal((await send("PROJECT_MANAGER", `/vendor-invoices/${releaseInvoice.body.id}/decision`, { action: "REVIEW", evidence: "BA checked" })).body.status, "REVIEWED");
    const releaseRequest = await send("PROCUREMENT", `/vendor-invoices/${releaseInvoice.body.id}/payments`, { amount: 100, evidence: "Request 100" });
    assert.equal(releaseRequest.status, 201);
    assert.equal((await send("DIRECTOR", `/vendor-payments/${releaseRequest.body.id}/decision`, { action: "APPROVE", evidence: "Approved 100" })).body.status, "APPROVED");
    const releaseBlocker = await pool.connect();
    await releaseBlocker.query("SELECT pg_advisory_lock(hashtext($1))", [commitmentId]);
    let blockedCancellation: ReturnType<typeof send> | undefined;
    let release: ReturnType<typeof send> | undefined;
    try {
      blockedCancellation = send("DIRECTOR", `/vendor-invoices/${releaseInvoice.body.id}/decision`, { action: "CANCEL", evidence: "Cannot cancel approved payment" });
      await waitForBlockedTransactions(1);
      release = send("FINANCE", `/vendor-payments/${releaseRequest.body.id}/decision`, { action: "RELEASE", evidence: "Bank transaction reference" });
      await waitForBlockedTransactions(2);
    } finally {
      await releaseBlocker.query("SELECT pg_advisory_unlock(hashtext($1))", [commitmentId]);
      releaseBlocker.release();
    }
    assert.equal((await blockedCancellation).status, 409, "Invoice dengan pembayaran aktif tidak bisa dibatalkan sebelum pencairan");
    assert.equal((await release).body.status, "RELEASED");
    assert.equal((await db.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, releaseInvoice.body.id)))[0].status, "REVIEWED");
  }, suite, timeout);
});