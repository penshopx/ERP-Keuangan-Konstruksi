import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invoicesTable,
  pool,
  projectsTable,
  rabBaselinesTable,
  rabItemsTable,
  rabTemplatesTable,
  taxCalculationSnapshotsTable,
  taxRuleVersionsTable,
} from "@workspace/db";
import { createApiRouter } from "./index";
import type { AccessContext } from "../middlewares/access";
import type { InvoicePersistenceHooks } from "./invoices";
import type { ProjectPersistenceHooks } from "./projects";
import {
  acquirePersistenceDatabaseSuiteLock,
  releasePersistenceDatabaseSuiteLock,
  type DatabaseSuiteLockClient,
} from "../testing/database-suite-lock";

const runId = randomUUID();
const projectCode = `TST-${runId.slice(0, 8)}`;
const taxRuleId = "tax-2022-construction-TANPA_KUALIFIKASI-true-false-false";
const continuedTaxRuleId = "tax-2022-construction-TANPA_KUALIFIKASI-true-false-true-continuation-2027-01-01";
const regressionProjectCodePattern = "^TST-([0-9a-f]{8}|RB-(baseline|audit)-[0-9a-f]{8})$";
const regressionUserIdPattern = "^test-user-[0-9a-f-]{36}$";
const regressionTaxRuleVersionPattern = "^TEST-(SUCCESSOR|CONCURRENT)-[0-9a-f-]{36}$";
const regressionDirectTaxRuleIdPattern = "^test-direct-(base|adjacent|overlap)-[0-9a-f-]{36}$";
const regressionRabTemplateIdPattern = "^test-rab-import-[0-9a-f-]{36}$";
const databaseSuiteLockTimeoutMs = Number(process.env.PERSISTENCE_TEST_LOCK_TIMEOUT_MS ?? 120_000);
const preventOverlappingTaxRulesMigrationUrl = new URL(
  "../../../../lib/db/migrations/0001_prevent_overlapping_tax_rule_periods.sql",
  import.meta.url,
);
let databaseSuiteLockClient: DatabaseSuiteLockClient | undefined;
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

function createTestApp(
  invoicePersistenceHooks: InvoicePersistenceHooks = {},
  testAccess: AccessContext = access,
  projectPersistenceHooks: ProjectPersistenceHooks = {},
): Express {
  const app = express();
  app.use(express.json());
  const testAccessMiddleware: express.RequestHandler = (req, _res, next) => {
    req.access = testAccess;
    next();
  };
  app.use("/api", createApiRouter(testAccessMiddleware, invoicePersistenceHooks, projectPersistenceHooks));
  return app;
}

async function startTestServer(
  invoicePersistenceHooks: InvoicePersistenceHooks = {},
  testAccess: AccessContext = access,
  projectPersistenceHooks: ProjectPersistenceHooks = {},
) {
  const server = createTestApp(invoicePersistenceHooks, testAccess, projectPersistenceHooks).listen(0, "127.0.0.1");
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

async function cleanupRegressionData() {
  await db.transaction(async (tx) => {
    const testProjects = await tx.select({ id: projectsTable.id })
      .from(projectsTable)
      .where(sql`${projectsTable.code} ~ ${regressionProjectCodePattern}`);
    const testProjectIds = testProjects.map(({ id }) => id);
    const testInvoices = testProjectIds.length > 0
      ? await tx.select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(inArray(invoicesTable.projectId, testProjectIds))
      : [];
    const testTaxRules = await tx.select({ id: taxRuleVersionsTable.id })
      .from(taxRuleVersionsTable)
      .where(sql`
        ${taxRuleVersionsTable.version} ~ ${regressionTaxRuleVersionPattern}
        OR ${taxRuleVersionsTable.id} ~ ${regressionDirectTaxRuleIdPattern}
      `);
    const testRabTemplates = await tx.select({ id: rabTemplatesTable.id })
      .from(rabTemplatesTable)
      .where(sql`${rabTemplatesTable.id} ~ ${regressionRabTemplateIdPattern}`);
    const testEntityIds = [
      ...testProjectIds,
      ...testInvoices.map(({ id }) => id),
      ...testTaxRules.map(({ id }) => id),
    ];

    if (testEntityIds.length > 0) {
      await tx.delete(auditLogsTable).where(sql`
        ${auditLogsTable.entityId} IN (${sql.join(testEntityIds.map((id) => sql`${id}`), sql`, `)})
        OR ${auditLogsTable.actorUserId} ~ ${regressionUserIdPattern}
      `);
    } else {
      await tx.delete(auditLogsTable)
        .where(sql`${auditLogsTable.actorUserId} ~ ${regressionUserIdPattern}`);
    }
    if (testProjects.length > 0) {
      await tx.delete(invoicesTable).where(inArray(invoicesTable.projectId, testProjectIds));
      await tx.delete(projectsTable).where(inArray(projectsTable.id, testProjectIds));
    }
    if (testTaxRules.length > 0) {
      await tx.delete(taxRuleVersionsTable).where(inArray(
        taxRuleVersionsTable.id,
        testTaxRules.map(({ id }) => id),
      ));
    }
    if (testRabTemplates.length > 0) {
      await tx.delete(rabTemplatesTable).where(inArray(
        rabTemplatesTable.id,
        testRabTemplates.map(({ id }) => id),
      ));
    }
    await tx.update(taxRuleVersionsTable).set({ effectiveTo: null }).where(eq(taxRuleVersionsTable.id, taxRuleId));
  });
}

async function acquireDatabaseSuiteLock() {
  if (!Number.isFinite(databaseSuiteLockTimeoutMs) || databaseSuiteLockTimeoutMs <= 0) {
    throw new Error(
      `PERSISTENCE_TEST_LOCK_TIMEOUT_MS must be a positive number; received ${process.env.PERSISTENCE_TEST_LOCK_TIMEOUT_MS}`,
    );
  }
  databaseSuiteLockClient = await acquirePersistenceDatabaseSuiteLock(databaseSuiteLockTimeoutMs);
}

async function releaseDatabaseSuiteLock() {
  const client = databaseSuiteLockClient;
  databaseSuiteLockClient = undefined;
  if (!client) return;
  await releasePersistenceDatabaseSuiteLock(client);
}

before(async () => {
  await acquireDatabaseSuiteLock();
  await cleanupRegressionData();
});

after(async () => {
  try {
    if (databaseSuiteLockClient) await cleanupRegressionData();
  } finally {
    try {
      await releaseDatabaseSuiteLock();
    } finally {
      await pool.end();
    }
  }
});

test("API persistence and invoice atomicity survive regressions", async (t) => {
  let projectId = "";

  await t.test("legacy bounded override migration preserves rates and is idempotent", async () => {
    const client = await pool.connect();
    const schemaName = `test_tax_migration_${runId.replaceAll("-", "")}`;
    const migrationSql = await readFile(preventOverlappingTaxRulesMigrationUrl, "utf8");
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}, public`);
      await client.query(`
        CREATE TABLE tax_rule_versions (
          id text PRIMARY KEY,
          version text NOT NULL,
          effective_from date NOT NULL,
          effective_to date,
          regulatory_source text NOT NULL,
          service_type text NOT NULL,
          qualification text,
          requires_sbu boolean NOT NULL,
          supplier_pkp boolean NOT NULL,
          government_collector boolean NOT NULL,
          integrated boolean NOT NULL,
          dpp_rate_basis_points integer NOT NULL,
          ppn_rate_basis_points integer NOT NULL,
          pph_final_rate_basis_points integer NOT NULL,
          pph_23_rate_basis_points integer NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        INSERT INTO tax_rule_versions (
          id, version, effective_from, effective_to, regulatory_source,
          service_type, qualification, requires_sbu, supplier_pkp,
          government_collector, integrated, dpp_rate_basis_points,
          ppn_rate_basis_points, pph_final_rate_basis_points,
          pph_23_rate_basis_points
        ) VALUES
          (
            'legacy-open', 'LEGACY-OPEN', '2022-01-01', NULL, 'Legacy regulation',
            'KONSTRUKSI', 'TANPA_KUALIFIKASI', false, true,
            false, true, 2750, 1100, 400, 0
          ),
          (
            'temporary-override', 'TEMPORARY-OVERRIDE', '2026-01-01', '2026-12-31',
            'Temporary exception', 'KONSTRUKSI', 'TANPA_KUALIFIKASI', false, true,
            false, true, 2750, 1100, 250, 0
          )
      `);

      await client.query(migrationSql);

      const segments = await client.query<{
        id: string;
        effective_from: string;
        effective_to: string | null;
        pph_final_rate_basis_points: number;
      }>(`
        SELECT id, effective_from::text, effective_to::text, pph_final_rate_basis_points
        FROM tax_rule_versions
        ORDER BY effective_from
      `);
      assert.deepEqual(segments.rows, [
        {
          id: "legacy-open",
          effective_from: "2022-01-01",
          effective_to: "2025-12-31",
          pph_final_rate_basis_points: 400,
        },
        {
          id: "temporary-override",
          effective_from: "2026-01-01",
          effective_to: "2026-12-31",
          pph_final_rate_basis_points: 250,
        },
        {
          id: "legacy-open-continuation-2027-01-01",
          effective_from: "2027-01-01",
          effective_to: null,
          pph_final_rate_basis_points: 400,
        },
      ]);

      const selectedRates = await client.query<{
        issued_at: string;
        id: string;
        pph_final_rate_basis_points: number;
      }>(`
        SELECT dates.issued_at::text, selected.id, selected.pph_final_rate_basis_points
        FROM (
          VALUES (DATE '2025-12-31'), (DATE '2026-06-30'), (DATE '2027-01-01')
        ) AS dates(issued_at)
        CROSS JOIN LATERAL (
          SELECT id, pph_final_rate_basis_points
          FROM tax_rule_versions
          WHERE service_type = 'KONSTRUKSI'
            AND qualification = 'TANPA_KUALIFIKASI'
            AND requires_sbu = false
            AND supplier_pkp = true
            AND government_collector = false
            AND integrated = true
            AND effective_from <= dates.issued_at
            AND (effective_to IS NULL OR effective_to >= dates.issued_at)
          ORDER BY effective_from DESC
          LIMIT 1
        ) AS selected
        ORDER BY dates.issued_at
      `);
      assert.deepEqual(selectedRates.rows, [
        { issued_at: "2025-12-31", id: "legacy-open", pph_final_rate_basis_points: 400 },
        { issued_at: "2026-06-30", id: "temporary-override", pph_final_rate_basis_points: 250 },
        {
          issued_at: "2027-01-01",
          id: "legacy-open-continuation-2027-01-01",
          pph_final_rate_basis_points: 400,
        },
      ]);

      await client.query(migrationSql);
      const rerun = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM tax_rule_versions",
      );
      assert.equal(rerun.rows[0]?.count, 3);
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      client.release();
    }
  });

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

      const preparationProjectInvoice = await fetch(`${firstServer.baseUrl}/invoices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          period: "Termin sebelum proyek berjalan",
          issuedAt: "2099-01-01",
          dpp: 10_000_000,
          retentionPercent: 5,
          integrated: false,
          serviceType: "KONSTRUKSI",
          qualification: "TANPA_KUALIFIKASI",
          hasSbu: false,
          supplierPkp: true,
          governmentCollector: false,
        }),
      });
      assert.equal(preparationProjectInvoice.status, 400);
      assert.deepEqual(
        await preparationProjectInvoice.json(),
        { error: "Invoice hanya dapat dibuat untuk proyek yang sedang berjalan" },
      );

      await requestJson(firstServer.baseUrl, `/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: "Proyek Persistensi Diperbarui",
          progress: 35,
          status: "BERJALAN",
        }),
      });

      const [storedInPostgres] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, projectId));
      assert.ok(storedInPostgres);
      assert.equal(storedInPostgres.name, "Proyek Persistensi Diperbarui");
      assert.equal(storedInPostgres.progress, 35);
      assert.equal(storedInPostgres.status, "BERJALAN");
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

  for (const failurePoint of ["baseline", "audit"] as const) {
    await t.test(`project creation rolls back project, baseline, and audit when ${failurePoint} insert fails`, async () => {
      const rollbackCode = `TST-RB-${failurePoint}-${runId.slice(0, 8)}`;
      let rollbackProjectId = "";
      const fail = async (projectId: string) => {
        rollbackProjectId = projectId;
        throw new Error(`Injected project ${failurePoint} insert failure`);
      };
      const projectHooks: ProjectPersistenceHooks = failurePoint === "baseline"
        ? { beforeBaselineInsert: fail }
        : { beforeAuditInsert: fail };
      const server = await startTestServer({}, access, projectHooks);
      try {
        const response = await fetch(`${server.baseUrl}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: rollbackCode,
            name: `Proyek Rollback ${failurePoint}`,
            owner: "Regression Test",
            contractValue: 50_000_000,
            endDate: "2027-12-31",
          }),
        });
        assert.equal(response.status, 500);
      } finally {
        await server.close();
      }

      assert.notEqual(rollbackProjectId, "");
      const [project] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, rollbackProjectId));
      const [baseline] = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.projectId, rollbackProjectId));
      const [audit] = await db.select().from(auditLogsTable)
        .where(and(
          eq(auditLogsTable.entity, "Proyek"),
          eq(auditLogsTable.entityId, rollbackProjectId),
        ));
      assert.equal(project, undefined);
      assert.equal(baseline, undefined);
      assert.equal(audit, undefined);
    });
  }

  await t.test("project update rolls back when its audit insert fails", async () => {
    const [before] = await db.select().from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    assert.ok(before);

    const auditsBefore = await db.select({ id: auditLogsTable.id }).from(auditLogsTable)
      .where(and(
        eq(auditLogsTable.entity, "Proyek"),
        eq(auditLogsTable.entityId, projectId),
        eq(auditLogsTable.action, "DIPERBARUI"),
      ));
    let injectedForProjectId = "";
    const server = await startTestServer({}, access, {
      beforeUpdateAuditInsert: async (hookProjectId) => {
        injectedForProjectId = hookProjectId;
        throw new Error("Injected project update audit insert failure");
      },
    });

    try {
      const response = await fetch(`${server.baseUrl}/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Perubahan yang wajib dibatalkan",
          progress: 88,
          contractValue: before.contractValue + 123_456,
        }),
      });
      assert.equal(response.status, 500);
    } finally {
      await server.close();
    }

    assert.equal(injectedForProjectId, projectId);
    const [after] = await db.select().from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    assert.ok(after);
    assert.equal(after.name, before.name);
    assert.equal(after.progress, before.progress);
    assert.equal(after.contractValue, before.contractValue);

    const auditsAfter = await db.select({ id: auditLogsTable.id }).from(auditLogsTable)
      .where(and(
        eq(auditLogsTable.entity, "Proyek"),
        eq(auditLogsTable.entityId, projectId),
        eq(auditLogsTable.action, "DIPERBARUI"),
      ));
    assert.deepEqual(auditsAfter, auditsBefore);
  });

  await t.test("RAB import rolls back baseline, items, project totals, and audit when audit insert fails", async () => {
    const templateId = `test-rab-import-${runId}`;
    await db.insert(rabTemplatesTable).values({
      id: templateId,
      name: "Template Rollback Impor RAB",
      projectType: "TEST",
      description: "Fixture unik untuk menguji atomicity impor RAB",
      sourceNote: "Regression test",
      items: [
        {
          code: "TEST.1",
          name: "Item yang wajib dibatalkan",
          category: "TEST",
          unit: "ls",
          quantity: 2,
          unitPrice: 123_456,
          materialCost: 100_000,
          laborCost: 20_000,
          equipmentCost: 3_456,
          parentCode: null,
          level: 1,
        },
      ],
    });

    try {
      const [projectBefore] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, projectId));
      assert.ok(projectBefore);
      const baselinesBefore = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.projectId, projectId));
      const baselineIdsBefore = baselinesBefore.map(({ id }) => id);
      const itemsBefore = baselineIdsBefore.length > 0
        ? await db.select().from(rabItemsTable).where(inArray(rabItemsTable.baselineId, baselineIdsBefore))
        : [];
      const auditsBefore = await db.select().from(auditLogsTable)
        .where(and(
          eq(auditLogsTable.entity, "RAB"),
          eq(auditLogsTable.action, "DIIMPOR"),
        ));

      let failedBaselineId = "";
      const server = await startTestServer({}, access, {
        beforeRabImportAuditInsert: async (hookProjectId, baselineId) => {
          assert.equal(hookProjectId, projectId);
          failedBaselineId = baselineId;
          throw new Error("Injected RAB import audit insert failure");
        },
      });
      try {
        const response = await fetch(`${server.baseUrl}/projects/${projectId}/rab/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ templateId, priceFactor: 1.25 }),
        });
        assert.equal(response.status, 500);
      } finally {
        await server.close();
      }

      assert.notEqual(failedBaselineId, "");
      const [projectAfter] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, projectId));
      const baselinesAfter = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.projectId, projectId));
      const baselineIdsAfter = baselinesAfter.map(({ id }) => id);
      const itemsAfter = baselineIdsAfter.length > 0
        ? await db.select().from(rabItemsTable).where(inArray(rabItemsTable.baselineId, baselineIdsAfter))
        : [];
      const [failedBaseline] = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.id, failedBaselineId));
      const failedItems = await db.select().from(rabItemsTable)
        .where(eq(rabItemsTable.baselineId, failedBaselineId));
      const [failedAudit] = await db.select().from(auditLogsTable)
        .where(and(
          eq(auditLogsTable.entity, "RAB"),
          eq(auditLogsTable.entityId, failedBaselineId),
          eq(auditLogsTable.action, "DIIMPOR"),
        ));
      const auditsAfter = await db.select().from(auditLogsTable)
        .where(and(
          eq(auditLogsTable.entity, "RAB"),
          eq(auditLogsTable.action, "DIIMPOR"),
        ));

      assert.ok(projectAfter);
      assert.equal(projectAfter.budget, projectBefore.budget);
      assert.equal(projectAfter.wbsCount, projectBefore.wbsCount);
      assert.deepEqual(baselinesAfter, baselinesBefore);
      assert.deepEqual(itemsAfter, itemsBefore);
      assert.equal(failedBaseline, undefined);
      assert.deepEqual(failedItems, []);
      assert.equal(failedAudit, undefined);
      assert.deepEqual(auditsAfter, auditsBefore);
    } finally {
      await db.delete(rabTemplatesTable).where(eq(rabTemplatesTable.id, templateId));
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

  await t.test("concurrent invoice transactions keep sequence numbers unique and issued-at periods intact", async () => {
    const concurrentCount = 4;
    let waitingAtInsert = 0;
    let releaseInserts!: () => void;
    const allTransactionsAtInsert = new Promise<void>((resolve) => {
      releaseInserts = resolve;
    });
    const server = await startTestServer({
      beforeInvoiceInsert: async () => {
        waitingAtInsert += 1;
        if (waitingAtInsert === concurrentCount) releaseInserts();
        await allTransactionsAtInsert;
      },
    });
    const issuedDates = [
      "2099-01-05",
      "2099-02-06",
      "2099-03-07",
      "2099-04-08",
    ];
    const taxCriteria = [
      { supplierPkp: false, governmentCollector: false, integrated: false },
      { supplierPkp: false, governmentCollector: true, integrated: false },
      { supplierPkp: true, governmentCollector: false, integrated: false },
      { supplierPkp: true, governmentCollector: true, integrated: false },
    ];

    try {
      const createdInvoices = await Promise.all(issuedDates.map((issuedAt, index) =>
        requestJson(server.baseUrl, "/invoices", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            period: `Termin Concurrent ${index + 1}`,
            issuedAt,
            dpp: 100_000_000 + index,
            retentionPercent: 5,
            serviceType: "KONSTRUKSI",
            qualification: "TANPA_KUALIFIKASI",
            hasSbu: false,
            ...taxCriteria[index],
          }),
        })
      ));
      const invoiceIds = createdInvoices.map(({ id }) => String(id));

      const storedInvoices = await db.select().from(invoicesTable)
        .where(inArray(invoicesTable.id, invoiceIds));
      assert.equal(storedInvoices.length, issuedDates.length);
      assert.equal(new Set(storedInvoices.map(({ number }) => number)).size, issuedDates.length);
      assert.equal(new Set(storedInvoices.map(({ sequence }) => sequence)).size, issuedDates.length);

      assert.equal(waitingAtInsert, concurrentCount);
      const expectedRomanMonths = ["I", "II", "III", "IV"];
      for (const [index, issuedAt] of issuedDates.entries()) {
        const stored = storedInvoices.find((invoice) => invoice.issuedAt === issuedAt);
        assert.ok(stored, `Invoice untuk issuedAt ${issuedAt} tidak tersimpan`);
        assert.equal(
          stored.number,
          `INV/${projectCode}/${expectedRomanMonths[index]}/2099/${String(stored.sequence).padStart(3, "0")}`,
        );
      }
    } finally {
      releaseInserts();
      await server.close();
    }
  });

  await t.test("a rolled-back invoice sequence is skipped and never reused", async () => {
    let failedAllocation: { id: string; number: string; sequence: number } | undefined;
    const failingServer = await startTestServer({
      afterInvoiceNumberAllocated: async (invoice) => {
        failedAllocation = invoice;
        throw new Error("Injected failure after invoice number allocation");
      },
    });
    const invoiceBody = {
      projectId,
      period: "Termin Sequence Rollback",
      issuedAt: "2099-05-09",
      dpp: 10_000,
      retentionPercent: 5,
      integrated: false,
      serviceType: "KONSTRUKSI",
      qualification: "TANPA_KUALIFIKASI",
      hasSbu: false,
      supplierPkp: true,
      governmentCollector: false,
    };

    try {
      const failedResponse = await fetch(`${failingServer.baseUrl}/invoices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invoiceBody),
      });
      assert.equal(failedResponse.status, 500);
    } finally {
      await failingServer.close();
    }

    assert.ok(failedAllocation);
    const [failedById] = await db.select().from(invoicesTable)
      .where(eq(invoicesTable.id, failedAllocation.id));
    const [failedByNumber] = await db.select().from(invoicesTable)
      .where(eq(invoicesTable.number, failedAllocation.number));
    assert.equal(failedById, undefined);
    assert.equal(failedByNumber, undefined);

    const succeedingServer = await startTestServer();
    try {
      const succeeded = await requestJson(succeedingServer.baseUrl, "/invoices", {
        method: "POST",
        body: JSON.stringify({ ...invoiceBody, period: "Termin Setelah Sequence Rollback" }),
      });

      const [stored] = await db.select().from(invoicesTable)
        .where(eq(invoicesTable.id, String(succeeded.id)));
      assert.ok(stored);
      assert.ok(stored.sequence > failedAllocation.sequence);
      assert.notEqual(stored.number, failedAllocation.number);
    } finally {
      await succeedingServer.close();
    }
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
      assert.equal(current.taxRuleVersionId, continuedTaxRuleId);

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

  await t.test("tax summary uses actual invoice taxes for the requested month", async () => {
    const server = await startTestServer();
    try {
      const construction = await requestJson(server.baseUrl, "/invoices", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          period: "Ringkasan konstruksi",
          issuedAt: "2098-05-10",
          dpp: 100_000_000,
          retentionPercent: 0,
          integrated: false,
          serviceType: "KONSTRUKSI",
          qualification: "KECIL",
          hasSbu: true,
          supplierPkp: false,
          governmentCollector: false,
        }),
      });
      const otherService = await requestJson(server.baseUrl, "/invoices", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          period: "Ringkasan jasa lain",
          issuedAt: "2098-05-20",
          dpp: 50_000_000,
          retentionPercent: 0,
          integrated: false,
          serviceType: "JASA_LAIN",
          qualification: "TIDAK_BERLAKU",
          hasSbu: false,
          supplierPkp: true,
          governmentCollector: false,
        }),
      });
      const outsidePeriod = await requestJson(server.baseUrl, "/invoices", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          period: "Ringkasan di luar periode",
          issuedAt: "2098-06-01",
          dpp: 25_000_000,
          retentionPercent: 0,
          integrated: false,
          serviceType: "JASA_LAIN",
          qualification: "TIDAK_BERLAKU",
          hasSbu: false,
          supplierPkp: false,
          governmentCollector: false,
        }),
      });

      const summary = await requestJson(server.baseUrl, "/tax/summary?period=2098-05");
      assert.equal(summary.period, "2098-05");
      assert.equal(summary.pphFinal, 1_750_000);
      assert.equal(summary.ppn, 5_500_200);
      assert.equal(summary.pph23, 1_000_000);
      assert.equal(summary.total, 8_250_200);
      assert.equal(summary.subLedgerTotal, 8_250_200);
      assert.equal(summary.documents, 2);
      assert.equal(summary.reconciliation, 1);

      await db.update(taxCalculationSnapshotsTable)
        .set({ ppn: Number(otherService.ppn) - 100_000 })
        .where(eq(taxCalculationSnapshotsTable.invoiceId, String(otherService.id)));

      const summaryWithVariance = await requestJson(server.baseUrl, "/tax/summary?period=2098-05");
      assert.equal(summaryWithVariance.subLedgerTotal, 8_150_200);
      assert.equal(summaryWithVariance.reconciliation, 8_150_200 / 8_250_200);

      await db.update(invoicesTable)
        .set({ ppn: 0, pphFinal: 0, pph23: 0 })
        .where(eq(invoicesTable.id, String(outsidePeriod.id)));
      await db.update(taxCalculationSnapshotsTable)
        .set({ ppn: 100_000, pphFinal: 0, pph23: 0 })
        .where(eq(taxCalculationSnapshotsTable.invoiceId, String(outsidePeriod.id)));

      const zeroLedgerWithVariance = await requestJson(server.baseUrl, "/tax/summary?period=2098-06");
      assert.equal(zeroLedgerWithVariance.total, 0);
      assert.equal(zeroLedgerWithVariance.subLedgerTotal, 100_000);
      assert.equal(zeroLedgerWithVariance.reconciliation, 0);

      const emptyMonth = await requestJson(server.baseUrl, "/tax/summary?period=2098-07");
      assert.equal(emptyMonth.pphFinal, 0);
      assert.equal(emptyMonth.ppn, 0);
      assert.equal(emptyMonth.pph23, 0);
      assert.equal(emptyMonth.total, 0);
      assert.equal(emptyMonth.subLedgerTotal, 0);
      assert.equal(emptyMonth.documents, 0);
      assert.equal(emptyMonth.reconciliation, 1);
    } finally {
      await server.close();
    }
  });

  await t.test("concurrent supersession cannot leave a new invoice on the old rule", async () => {
    const raceRuleId = continuedTaxRuleId;
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

  await t.test("database and API both reject overlapping tax rules while allowing adjacent periods", async () => {
    const directRuleIds = [
      `test-direct-base-${runId}`,
      `test-direct-adjacent-${runId}`,
      `test-direct-overlap-${runId}`,
    ];
    const baseRule = {
      regulatorySource: "Direct database overlap regression test",
      serviceType: `TEST_SERVICE_${runId}`,
      qualification: null,
      requiresSbu: false,
      supplierPkp: false,
      governmentCollector: false,
      integrated: false,
      dppRateBasisPoints: 10_000,
      ppnRateBasisPoints: 0,
      pphFinalRateBasisPoints: 0,
      pph23RateBasisPoints: 200,
    };

    await db.insert(taxRuleVersionsTable).values({
      id: directRuleIds[0],
      version: `TEST-DIRECT-BASE-${runId}`,
      effectiveFrom: "2300-01-01",
      effectiveTo: "2300-01-31",
      ...baseRule,
    });
    await db.insert(taxRuleVersionsTable).values({
      id: directRuleIds[1],
      version: `TEST-DIRECT-ADJACENT-${runId}`,
      effectiveFrom: "2300-02-01",
      effectiveTo: "2300-02-28",
      ...baseRule,
    });
    await assert.rejects(
      db.insert(taxRuleVersionsTable).values({
        id: directRuleIds[2],
        version: `TEST-DIRECT-OVERLAP-${runId}`,
        effectiveFrom: "2300-01-31",
        effectiveTo: "2300-02-15",
        ...baseRule,
      }),
      (error: unknown) => {
        const candidate = error as { cause?: { code?: string; constraint?: string } };
        return candidate.cause?.code === "23P01"
          && candidate.cause.constraint === "tax_rule_versions_no_overlapping_periods";
      },
    );

    const server = await startTestServer();
    try {
      const response = await fetch(`${server.baseUrl}/tax/rules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: `TEST-API-OVERLAP-${runId}`,
          effectiveFrom: "2026-06-15",
          effectiveTo: "2026-06-20",
          regulatorySource: "API overlap regression test",
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
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "Periode berlaku tumpang tindih dengan aturan berkriteria sama.",
      });
    } finally {
      await server.close();
    }

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(taxRuleVersionsTable)
      .where(inArray(taxRuleVersionsTable.id, directRuleIds));
    assert.equal(count, 2);
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