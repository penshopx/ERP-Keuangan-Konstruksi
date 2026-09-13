import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invoicesTable,
  pool,
  projectsTable,
  rabBaselinesTable,
  taxCalculationSnapshotsTable,
  taxRuleVersionsTable,
} from "@workspace/db";
import { createApiRouter } from "./index";
import type { AccessContext } from "../middlewares/access";
import type { InvoicePersistenceHooks } from "./invoices";

const runId = randomUUID();
const projectCode = `TST-${runId.slice(0, 8)}`;
const taxRuleId = "tax-2022-construction-TANPA_KUALIFIKASI-true-false-false";
const createdEntityIds: string[] = [];
const createdTaxRuleIds: string[] = [];

const access: AccessContext = {
  userId: `test-user-${runId}`,
  displayName: "Regression Test",
  role: "DIRECTOR",
  assignedProjectIds: [],
  permissions: [],
};

function createTestApp(invoicePersistenceHooks: InvoicePersistenceHooks = {}, testAccess: AccessContext = access): Express {
  const app = express();
  app.use(express.json());
  const testAccessMiddleware: express.RequestHandler = (req, _res, next) => {
    req.access = testAccess;
    next();
  };
  app.use("/api", createApiRouter(testAccessMiddleware, invoicePersistenceHooks));
  return app;
}

async function startTestServer(invoicePersistenceHooks: InvoicePersistenceHooks = {}, testAccess: AccessContext = access) {
  const server = createTestApp(invoicePersistenceHooks, testAccess).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function requestJson(baseUrl: string, path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  assert.ok(response.ok, `${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body as Record<string, unknown>;
}

after(async () => {
  await db.transaction(async (tx) => {
    if (createdEntityIds.length > 0) {
      await tx.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, createdEntityIds));
    }
    const testProjects = await tx.select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.code, projectCode));
    if (testProjects.length > 0) {
      await tx.delete(invoicesTable).where(inArray(invoicesTable.projectId, testProjects.map(({ id }) => id)));
    }
    await tx.delete(projectsTable).where(eq(projectsTable.code, projectCode));
    if (createdTaxRuleIds.length > 0) {
      await tx.delete(taxRuleVersionsTable).where(inArray(taxRuleVersionsTable.id, createdTaxRuleIds));
    }
    await tx.update(taxRuleVersionsTable).set({ effectiveTo: null }).where(eq(taxRuleVersionsTable.id, taxRuleId));
  });
  await pool.end();
});

test("API persistence and invoice atomicity survive regressions", async (t) => {
  let projectId = "";

  await t.test("project create and update remain readable after server restart", async () => {
    const firstServer = await startTestServer();
    try {
      const created = await requestJson(firstServer.baseUrl, "/projects", {
        method: "POST",
        body: JSON.stringify({
          code: projectCode,
          name: "Proyek Persistensi",
          owner: "Pemilik Awal",
          contractValue: 1_500_000_000,
          endDate: "2027-12-31",
        }),
      });
      projectId = String(created.id);
      createdEntityIds.push(projectId);

      await requestJson(firstServer.baseUrl, `/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Proyek Persistensi Diperbarui", progress: 35 }),
      });

      const [storedInPostgres] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, projectId));
      assert.ok(storedInPostgres);
      assert.equal(storedInPostgres.name, "Proyek Persistensi Diperbarui");
      assert.equal(storedInPostgres.progress, 35);
    } finally {
      await firstServer.close();
    }

    const restartedServer = await startTestServer();
    try {
      const persisted = await requestJson(restartedServer.baseUrl, `/projects/${projectId}`);
      assert.equal(persisted.id, projectId);
      assert.equal(persisted.name, "Proyek Persistensi Diperbarui");
      assert.equal(persisted.progress, 35);
      assert.equal(persisted.contractValue, 1_500_000_000);
    } finally {
      await restartedServer.close();
    }
  });

  await t.test("invoice, tax snapshot, and audit are committed together", async () => {
    const server = await startTestServer();
    let invoiceId = "";
    try {
      const invoice = await requestJson(server.baseUrl, "/invoices", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          period: "Termin Regression",
          issuedAt: "2099-09-13",
          dpp: 100_000_000,
          retentionPercent: 5,
          integrated: false,
          serviceType: "KONSTRUKSI",
          qualification: "TANPA_KUALIFIKASI",
          hasSbu: false,
          supplierPkp: true,
          governmentCollector: false,
        }),
      });
      invoiceId = String(invoice.id);
      createdEntityIds.push(invoiceId);
    } finally {
      await server.close();
    }

    const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
    const [snapshot] = await db.select().from(taxCalculationSnapshotsTable)
      .where(eq(taxCalculationSnapshotsTable.invoiceId, invoiceId));
    const [audit] = await db.select().from(auditLogsTable).where(and(
      eq(auditLogsTable.entity, "Invoice"),
      eq(auditLogsTable.entityId, invoiceId),
    ));

    assert.ok(invoice);
    assert.ok(snapshot);
    assert.ok(audit);
    assert.equal(invoice.taxRuleVersionId, taxRuleId);
    assert.equal(snapshot.taxRuleVersionId, taxRuleId);
  });

  await t.test("concurrent supersession cannot leave a new invoice on the old rule", async () => {
    const raceRuleId = "tax-2022-construction-TANPA_KUALIFIKASI-true-false-true";
    let signalSelected!: () => void;
    let releaseSelection!: () => void;
    const selected = new Promise<void>((resolve) => { signalSelected = resolve; });
    const release = new Promise<void>((resolve) => { releaseSelection = resolve; });
    const server = await startTestServer({
      afterTaxRuleSelection: async (ruleId) => {
        if (ruleId === raceRuleId) {
          signalSelected();
          await release;
        }
      },
    });
    try {
      const invoiceRequest = fetch(`${server.baseUrl}/invoices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          period: "Termin Concurrent",
          issuedAt: "2100-02-01",
          dpp: 100_000_000,
          retentionPercent: 0,
          integrated: true,
          serviceType: "KONSTRUKSI",
          qualification: "TANPA_KUALIFIKASI",
          hasSbu: false,
          supplierPkp: true,
          governmentCollector: false,
        }),
      });
      await selected;
      const successorRequest = fetch(`${server.baseUrl}/tax/rules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: `TEST-CONCURRENT-${runId}`,
          effectiveFrom: "2100-01-01",
          effectiveTo: null,
          regulatorySource: "Concurrent integration test regulation",
          serviceType: "KONSTRUKSI",
          qualification: "TANPA_KUALIFIKASI",
          requiresSbu: false,
          supplierPkp: true,
          governmentCollector: false,
          integrated: true,
          dppRateBasisPoints: 10_000,
          ppnRateBasisPoints: 1_200,
          pphFinalRateBasisPoints: 300,
          pph23RateBasisPoints: 0,
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseSelection();
      const [invoiceResponse, successorResponse] = await Promise.all([invoiceRequest, successorRequest]);
      const invoice = await invoiceResponse.json() as Record<string, unknown>;
      assert.equal(invoiceResponse.status, 201, JSON.stringify(invoice));
      assert.equal(invoice.taxRuleVersionId, raceRuleId);
      createdEntityIds.push(String(invoice.id));
      assert.equal(successorResponse.status, 409);
      const [unexpectedSuccessor] = await db.select().from(taxRuleVersionsTable)
        .where(eq(taxRuleVersionsTable.version, `TEST-CONCURRENT-${runId}`));
      assert.equal(unexpectedSuccessor, undefined);
    } finally {
      releaseSelection();
      await server.close();
    }
  });

  await t.test("Finance can supersede an open-ended rule without changing historical invoices", async () => {
    const server = await startTestServer();
    let successorId = "";
    try {
      const response = await fetch(`${server.baseUrl}/tax/rules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: `TEST-SUCCESSOR-${runId}`,
          effectiveFrom: "2100-01-01",
          effectiveTo: null,
          regulatorySource: "Successor integration test regulation",
          serviceType: "KONSTRUKSI",
          qualification: "TANPA_KUALIFIKASI",
          requiresSbu: false,
          supplierPkp: true,
          governmentCollector: false,
          integrated: false,
          dppRateBasisPoints: 10_000,
          ppnRateBasisPoints: 1_200,
          pphFinalRateBasisPoints: 300,
          pph23RateBasisPoints: 0,
        }),
      });
      const created = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 201, JSON.stringify(created));
      successorId = String(created.id);
      createdTaxRuleIds.push(successorId);
      createdEntityIds.push(successorId);

      const invoice = await requestJson(server.baseUrl, "/invoices", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          period: "Termin Successor",
          issuedAt: "2100-01-02",
          dpp: 100_000_000,
          retentionPercent: 0,
          integrated: false,
          serviceType: "KONSTRUKSI",
          qualification: "TANPA_KUALIFIKASI",
          hasSbu: false,
          supplierPkp: true,
          governmentCollector: false,
        }),
      });
      createdEntityIds.push(String(invoice.id));
      assert.equal(invoice.taxRuleVersionId, successorId);

      const overlap = await fetch(`${server.baseUrl}/tax/rules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: `TEST-RETROACTIVE-${runId}`,
          effectiveFrom: "2099-06-01",
          effectiveTo: null,
          regulatorySource: "Invalid retroactive test regulation",
          serviceType: "KONSTRUKSI",
          qualification: "TANPA_KUALIFIKASI",
          requiresSbu: false,
          supplierPkp: true,
          governmentCollector: false,
          integrated: false,
          dppRateBasisPoints: 10_000,
          ppnRateBasisPoints: 1_200,
          pphFinalRateBasisPoints: 300,
          pph23RateBasisPoints: 0,
        }),
      });
      assert.equal(overlap.status, 409);

      const missingQualification = await fetch(`${server.baseUrl}/tax/rules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: `TEST-NO-QUALIFICATION-${runId}`,
          effectiveFrom: "2200-01-01",
          regulatorySource: "Invalid qualification test regulation",
          serviceType: "KONSTRUKSI",
          qualification: null,
          requiresSbu: false,
          supplierPkp: false,
          governmentCollector: false,
          integrated: false,
          dppRateBasisPoints: 10_000,
          ppnRateBasisPoints: 0,
          pphFinalRateBasisPoints: 0,
          pph23RateBasisPoints: 0,
        }),
      });
      assert.equal(missingQualification.status, 400);
    } finally {
      await server.close();
    }

    const [previous] = await db.select().from(taxRuleVersionsTable).where(eq(taxRuleVersionsTable.id, taxRuleId));
    const [audit] = await db.select().from(auditLogsTable).where(and(
      eq(auditLogsTable.entity, "Aturan Pajak"),
      eq(auditLogsTable.entityId, successorId),
    ));
    assert.equal(previous.effectiveTo, "2099-12-31");
    assert.ok(audit);
  });

  await t.test("tax rule endpoints reject roles without management permission", async () => {
    const server = await startTestServer({}, { ...access, role: "TAX_STAFF" });
    try {
      const response = await fetch(`${server.baseUrl}/tax/rules`);
      assert.equal(response.status, 403);
    } finally {
      await server.close();
    }
  });

  await t.test("an endpoint insert failure rolls back invoice, snapshot, and audit", async () => {
    let rollbackInvoiceId = "";
    const server = await startTestServer({
      beforeAuditInsert: async (invoiceId) => {
        rollbackInvoiceId = invoiceId;
        throw new Error("Injected audit insert failure");
      },
    });
    try {
      const response = await fetch(`${server.baseUrl}/invoices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          period: "Rollback Test",
          issuedAt: "2099-09-13",
          dpp: 10_000,
          retentionPercent: 5,
          integrated: false,
          serviceType: "KONSTRUKSI",
          qualification: "TANPA_KUALIFIKASI",
          hasSbu: false,
          supplierPkp: true,
          governmentCollector: false,
        }),
      });
      assert.equal(response.status, 500);
    } finally {
      await server.close();
    }

    assert.notEqual(rollbackInvoiceId, "");

    const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, rollbackInvoiceId));
    const [snapshot] = await db.select().from(taxCalculationSnapshotsTable)
      .where(eq(taxCalculationSnapshotsTable.invoiceId, rollbackInvoiceId));
    const [audit] = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, rollbackInvoiceId));
    assert.equal(invoice, undefined);
    assert.equal(snapshot, undefined);
    assert.equal(audit, undefined);
  });
});