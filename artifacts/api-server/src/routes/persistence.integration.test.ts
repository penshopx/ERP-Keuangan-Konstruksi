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
const constructionQualifications = [
  { qualification: "KECIL", hasSbu: true, pphFinal: 2_100_000 },
  { qualification: "MENENGAH", hasSbu: true, pphFinal: 3_180_000 },
  { qualification: "BESAR", hasSbu: true, pphFinal: 3_180_000 },
  { qualification: "TANPA_KUALIFIKASI", hasSbu: false, pphFinal: 4_800_000 },
] as const;

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

  await t.test("invoice validation and effective-date rule selection cover every tax branch", async () => {
    const server = await startTestServer();
    const dpp = 120_000_000;
    const retention = 6_000_000;
    const taxableDpp = 110_004_000;
    const ppn = 13_200_480;
    try {
      for (const item of constructionQualifications) {
        for (const supplierPkp of [false, true]) {
          for (const governmentCollector of [false, true]) {
            for (const integrated of [false, true]) {
              const invoice = await requestJson(server.baseUrl, "/invoices", {
                method: "POST",
                body: JSON.stringify({
                  projectId,
                  period: `Matrix ${item.qualification}`,
                  issuedAt: "2099-06-15",
                  dpp,
                  retentionPercent: 5,
                  integrated,
                  serviceType: "KONSTRUKSI",
                  qualification: item.qualification,
                  hasSbu: item.hasSbu,
                  supplierPkp,
                  governmentCollector,
                }),
              });
              createdEntityIds.push(String(invoice.id));
              assert.equal(invoice.ppn, supplierPkp ? ppn : 0);
              assert.equal(invoice.pphFinal, item.pphFinal);
              assert.equal(invoice.pph23, 0);
              assert.equal(invoice.retention, retention);
              assert.equal(
                invoice.total,
                dpp + (supplierPkp && !governmentCollector ? ppn : 0) - item.pphFinal - retention,
              );

              const [snapshot] = await db.select().from(taxCalculationSnapshotsTable)
                .where(eq(taxCalculationSnapshotsTable.invoiceId, String(invoice.id)));
              assert.ok(snapshot);
              assert.equal(snapshot.dppLainRateBasisPoints, supplierPkp ? 9167 : 0);
              assert.equal(snapshot.ppn, supplierPkp ? ppn : 0);
              assert.equal(snapshot.pphFinal, item.pphFinal);
              assert.equal(snapshot.retention, retention);
            }
          }
        }
      }

      for (const supplierPkp of [false, true]) {
        for (const governmentCollector of [false, true]) {
          const invoice = await requestJson(server.baseUrl, "/invoices", {
            method: "POST",
            body: JSON.stringify({
              projectId,
              period: "Matrix Jasa Lain",
              issuedAt: "2099-06-15",
              dpp,
              retentionPercent: 5,
              integrated: false,
              serviceType: "JASA_LAIN",
              qualification: "TIDAK_BERLAKU",
              hasSbu: false,
              supplierPkp,
              governmentCollector,
            }),
          });
          createdEntityIds.push(String(invoice.id));
          assert.equal(invoice.ppn, supplierPkp ? ppn : 0);
          assert.equal(invoice.pphFinal, 0);
          assert.equal(invoice.pph23, 2_400_000);
          assert.equal(invoice.retention, retention);
          assert.equal(
            invoice.total,
            dpp + (supplierPkp && !governmentCollector ? ppn : 0) - 2_400_000 - retention,
          );
        }
      }

      const legacy = await requestJson(server.baseUrl, "/invoices", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          period: "Batas Versi Legacy",
          issuedAt: "2026-12-31",
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
      createdEntityIds.push(String(legacy.id));
      assert.equal(legacy.taxRuleVersionId, "tax-legacy-demo-2026");
      assert.equal(legacy.ppn, 3_025_000);
      assert.equal(legacy.pphFinal, 2_500_000);
      assert.equal(legacy.total, 100_525_000);

      const current = await requestJson(server.baseUrl, "/invoices", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          period: "Batas Versi Berlaku",
          issuedAt: "2027-01-01",
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
      createdEntityIds.push(String(current.id));
      assert.equal(current.taxRuleVersionId, "tax-2022-construction-TANPA_KUALIFIKASI-true-false-true");

      const invalidCases = [
        {
          body: { dpp: -1 },
          status: 400,
        },
        {
          body: { retentionPercent: 101 },
          status: 400,
        },
        {
          body: { qualification: "KECIL", hasSbu: false },
          status: 400,
        },
        {
          body: { serviceType: "JASA_LAIN", qualification: "KECIL", hasSbu: true },
          status: 400,
        },
        {
          body: { serviceType: "JASA_LAIN", qualification: "TIDAK_BERLAKU", integrated: true },
          status: 400,
        },
        {
          body: { issuedAt: "2020-01-01" },
          status: 422,
        },
      ];
      const validBase = {
        projectId,
        period: "Validasi Matrix",
        issuedAt: "2099-06-15",
        dpp,
        retentionPercent: 5,
        integrated: false,
        serviceType: "KONSTRUKSI",
        qualification: "TANPA_KUALIFIKASI",
        hasSbu: false,
        supplierPkp: true,
        governmentCollector: false,
      };
      for (const invalidCase of invalidCases) {
        const response = await fetch(`${server.baseUrl}/invoices`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...validBase, ...invalidCase.body }),
        });
        assert.equal(response.status, invalidCase.status, await response.text());
      }
    } finally {
      await server.close();
    }
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
    let historicalInvoiceId = "";
    let historicalInvoiceBefore: typeof invoicesTable.$inferSelect | undefined;
    let historicalSnapshotBefore: typeof taxCalculationSnapshotsTable.$inferSelect | undefined;
    try {
      const historicalInvoice = await requestJson(server.baseUrl, "/invoices", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          period: "Termin Posted Historis",
          issuedAt: "2099-12-31",
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
      historicalInvoiceId = String(historicalInvoice.id);
      createdEntityIds.push(historicalInvoiceId);
      await requestJson(server.baseUrl, `/invoices/${historicalInvoiceId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "APPROVE", note: "Posted untuk pengujian historis" }),
      });
      [historicalInvoiceBefore] = await db.select().from(invoicesTable)
        .where(eq(invoicesTable.id, historicalInvoiceId));
      [historicalSnapshotBefore] = await db.select().from(taxCalculationSnapshotsTable)
        .where(eq(taxCalculationSnapshotsTable.invoiceId, historicalInvoiceId));
      assert.equal(historicalInvoiceBefore?.status, "DISETUJUI");
      assert.ok(historicalSnapshotBefore);

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

    const [historicalInvoiceAfter] = await db.select().from(invoicesTable)
      .where(eq(invoicesTable.id, historicalInvoiceId));
    const [historicalSnapshotAfter] = await db.select().from(taxCalculationSnapshotsTable)
      .where(eq(taxCalculationSnapshotsTable.invoiceId, historicalInvoiceId));
    const [previous] = await db.select().from(taxRuleVersionsTable).where(eq(taxRuleVersionsTable.id, taxRuleId));
    const [audit] = await db.select().from(auditLogsTable).where(and(
      eq(auditLogsTable.entity, "Aturan Pajak"),
      eq(auditLogsTable.entityId, successorId),
    ));
    assert.deepEqual(historicalInvoiceAfter, historicalInvoiceBefore);
    assert.deepEqual(historicalSnapshotAfter, historicalSnapshotBefore);
    assert.equal(historicalInvoiceAfter.ppn, 11_000_400);
    assert.equal(historicalInvoiceAfter.pphFinal, 4_000_000);
    assert.equal(historicalInvoiceAfter.pph23, 0);
    assert.equal(historicalInvoiceAfter.retention, 5_000_000);
    assert.equal(historicalInvoiceAfter.total, 102_000_400);
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