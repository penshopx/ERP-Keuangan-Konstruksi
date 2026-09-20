import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, mock, test } from "node:test";
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
  describeDatabaseSuiteError,
  releasePersistenceDatabaseSuiteLock,
  runDatabaseSuiteOperation,
  setDatabaseSuitePoolStatementTimeout,
  type DatabaseSuiteLockClient,
} from "../testing/database-suite-lock";
import { getPersistenceDatabaseSuiteConfig } from "../testing/database-suite-config";

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
const {
  suiteName: databaseSuiteName,
  statementTimeoutMs: databaseStatementTimeoutMs,
} = getPersistenceDatabaseSuiteConfig();
const preventOverlappingTaxRulesMigrationUrl = new URL(
  "../../../../lib/db/migrations/0001_prevent_overlapping_tax_rule_periods.sql",
  import.meta.url,
);
const preserveMultipleBoundedTaxOverridesMigrationUrl = new URL(
  "../../../../lib/db/migrations/0002_preserve_multiple_bounded_tax_overrides.sql",
  import.meta.url,
);
const rabImportProcessWorkerUrl = new URL(
  "../testing/rab-import-process.worker.ts",
  import.meta.url,
);
const restrictProjectStatusMigrationUrl = new URL(
  "../../../../lib/db/migrations/0004_restrict_project_status.sql",
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

function startRabImportProcess(
  mode: "fail" | "succeed",
  projectId: string,
  templateId: string,
  priceFactor: number,
) {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    rabImportProcessWorkerUrl.pathname,
    mode,
    projectId,
    templateId,
    String(priceFactor),
    `test-user-${randomUUID()}`,
  ], { cwd: process.cwd(), env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout: () => stdout, stderr: () => stderr, result };
}

function waitForWorkerOutput(
  child: ChildProcessWithoutNullStreams,
  expected: RegExp,
  read: () => string,
) {
  return new Promise<RegExpMatchArray>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}; stdout: ${read()}`));
    }, 10_000);
    const onData = () => {
      const match = read().match(expected);
      if (!match) return;
      cleanup();
      resolve(match);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Worker exited before ${expected}; stdout: ${read()}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.once("close", onClose);
    onData();
  });
}

async function stopRabImportProcess(worker: ReturnType<typeof startRabImportProcess>) {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill("SIGTERM");
  }
  await worker.result;
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
  setDatabaseSuitePoolStatementTimeout(databaseSuiteName, databaseStatementTimeoutMs);
  await runDatabaseSuiteOperation(async () => {
    await acquireDatabaseSuiteLock();
    await cleanupRegressionData();
  }, databaseSuiteName, databaseStatementTimeoutMs);
});

after(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    if (databaseSuiteLockClient) {
      try {
        await cleanupRegressionData();
      } catch (error) {
        cleanupErrors.push(describeDatabaseSuiteError(error, databaseSuiteName, databaseStatementTimeoutMs));
      }
    }
  } finally {
    try {
      try {
        await releaseDatabaseSuiteLock();
      } catch (error) {
        cleanupErrors.push(describeDatabaseSuiteError(error, databaseSuiteName, databaseStatementTimeoutMs));
      }
    } finally {
      await pool.end();
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `${databaseSuiteName} cleanup or lock release failed`);
  }
});

test("API persistence and invoice atomicity survive regressions", async (t) => {
  await runDatabaseSuiteOperation(async () => {
  let projectId = "";

  await t.test("project status migration rejects unknown legacy values without rewriting them", async () => {
    const client = await pool.connect();
    const schemaName = `test_project_status_migration_${runId.replaceAll("-", "")}`;
    const migrationSql = await readFile(restrictProjectStatusMigrationUrl, "utf8");
    // @ts-expect-error The migration runner is intentionally plain JavaScript.
    const { runMigrations } = await import("../../../../lib/db/scripts/migrate.mjs");
    const migration = {
      name: "0004_restrict_project_status.sql",
      sql: migrationSql,
      checksum: createHash("sha256").update(migrationSql).digest("hex"),
    };
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}, public`);
      await client.query("CREATE TABLE projects (id text PRIMARY KEY, status text NOT NULL)");
      await client.query(
        "INSERT INTO projects (id, status) VALUES ('legacy-project', 'ACTIVE')",
      );

      await assert.rejects(
        runMigrations(client, [migration]),
        /unsupported existing values: 'ACTIVE'/,
      );

      const legacyProject = await client.query<{ status: string }>(
        "SELECT status FROM projects WHERE id = 'legacy-project'",
      );
      assert.equal(legacyProject.rows[0]?.status, "ACTIVE");

      await client.query(
        "UPDATE projects SET status = 'PERSIAPAN' WHERE id = 'legacy-project'",
      );
      await runMigrations(client, [migration]);
      await assert.rejects(
        client.query(
          "UPDATE projects SET status = 'ACTIVE' WHERE id = 'legacy-project'",
        ),
        /projects_status_supported/,
      );
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      client.release();
    }
  });

  await t.test("legacy migration preserves rates across a longer mixed sequence of bounded overrides", async () => {
    const client = await pool.connect();
    const schemaName = `test_tax_migration_${runId.replaceAll("-", "")}`;
    const migrationSql = await readFile(preventOverlappingTaxRulesMigrationUrl, "utf8");
    const correctiveMigrationSql = await readFile(
      preserveMultipleBoundedTaxOverridesMigrationUrl,
      "utf8",
    );
    // @ts-expect-error The migration runner is intentionally plain JavaScript.
    const { runMigrations } = await import("../../../../lib/db/scripts/migrate.mjs");
    const originalMigration = {
      name: "0001_prevent_overlapping_tax_rule_periods.sql",
      sql: migrationSql,
      checksum: createHash("sha256").update(migrationSql).digest("hex"),
    };
    const correctiveMigration = {
      name: "0002_preserve_multiple_bounded_tax_overrides.sql",
      sql: correctiveMigrationSql,
      checksum: createHash("sha256").update(correctiveMigrationSql).digest("hex"),
    };
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
            'temporary-override-2024', 'TEMPORARY-OVERRIDE-2024',
            '2024-01-01', '2024-03-31',
            'First temporary exception', 'KONSTRUKSI', 'TANPA_KUALIFIKASI', false, true,
            false, true, 2750, 1100, 250, 0
          ),
          (
            'adjacent-override-2024', 'ADJACENT-OVERRIDE-2024',
            '2024-04-01', '2024-06-30',
            'Adjacent temporary exception', 'KONSTRUKSI', 'TANPA_KUALIFIKASI', false, true,
            false, true, 2750, 1100, 300, 0
          ),
          (
            'temporary-override-2025', 'TEMPORARY-OVERRIDE-2025',
            '2025-01-01', '2025-06-30',
            'Third temporary exception, separated by a real gap', 'KONSTRUKSI', 'TANPA_KUALIFIKASI', false, true,
            false, true, 2750, 1100, 350, 0
          ),
          (
            'temporary-override-2026', 'TEMPORARY-OVERRIDE-2026',
            '2026-01-01', '2026-12-31',
            'Fourth temporary exception, separated by another real gap', 'KONSTRUKSI', 'TANPA_KUALIFIKASI', false, true,
            false, true, 2750, 1100, 250, 0
          )
      `);

      await runMigrations(client, [originalMigration]);
      await runMigrations(client, [originalMigration, correctiveMigration]);

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
          effective_to: "2023-12-31",
          pph_final_rate_basis_points: 400,
        },
        {
          id: "temporary-override-2024",
          effective_from: "2024-01-01",
          effective_to: "2024-03-31",
          pph_final_rate_basis_points: 250,
        },
        {
          id: "adjacent-override-2024",
          effective_from: "2024-04-01",
          effective_to: "2024-06-30",
          pph_final_rate_basis_points: 300,
        },
        {
          id: "legacy-open-continuation-2024-07-01",
          effective_from: "2024-07-01",
          effective_to: "2024-12-31",
          pph_final_rate_basis_points: 400,
        },
        {
          id: "temporary-override-2025",
          effective_from: "2025-01-01",
          effective_to: "2025-06-30",
          pph_final_rate_basis_points: 350,
        },
        {
          id: "legacy-open-continuation-2025-07-01",
          effective_from: "2025-07-01",
          effective_to: "2025-12-31",
          pph_final_rate_basis_points: 400,
        },
        {
          id: "temporary-override-2026",
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
          VALUES
            (DATE '2023-12-31'),
            (DATE '2024-01-01'),
            (DATE '2024-02-15'),
            (DATE '2024-03-31'),
            (DATE '2024-04-01'),
            (DATE '2024-06-30'),
            (DATE '2024-07-01'),
            (DATE '2024-12-31'),
            (DATE '2025-01-01'),
            (DATE '2025-06-30'),
            (DATE '2025-07-01'),
            (DATE '2025-12-31'),
            (DATE '2026-01-01'),
            (DATE '2026-06-30'),
            (DATE '2026-12-31'),
            (DATE '2027-01-01')
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
        { issued_at: "2023-12-31", id: "legacy-open", pph_final_rate_basis_points: 400 },
        {
          issued_at: "2024-01-01",
          id: "temporary-override-2024",
          pph_final_rate_basis_points: 250,
        },
        {
          issued_at: "2024-02-15",
          id: "temporary-override-2024",
          pph_final_rate_basis_points: 250,
        },
        {
          issued_at: "2024-03-31",
          id: "temporary-override-2024",
          pph_final_rate_basis_points: 250,
        },
        {
          issued_at: "2024-04-01",
          id: "adjacent-override-2024",
          pph_final_rate_basis_points: 300,
        },
        {
          issued_at: "2024-06-30",
          id: "adjacent-override-2024",
          pph_final_rate_basis_points: 300,
        },
        {
          issued_at: "2024-07-01",
          id: "legacy-open-continuation-2024-07-01",
          pph_final_rate_basis_points: 400,
        },
        {
          issued_at: "2024-12-31",
          id: "legacy-open-continuation-2024-07-01",
          pph_final_rate_basis_points: 400,
        },
        {
          issued_at: "2025-01-01",
          id: "temporary-override-2025",
          pph_final_rate_basis_points: 350,
        },
        {
          issued_at: "2025-06-30",
          id: "temporary-override-2025",
          pph_final_rate_basis_points: 350,
        },
        {
          issued_at: "2025-07-01",
          id: "legacy-open-continuation-2025-07-01",
          pph_final_rate_basis_points: 400,
        },
        {
          issued_at: "2025-12-31",
          id: "legacy-open-continuation-2025-07-01",
          pph_final_rate_basis_points: 400,
        },
        {
          issued_at: "2026-01-01",
          id: "temporary-override-2026",
          pph_final_rate_basis_points: 250,
        },
        {
          issued_at: "2026-06-30",
          id: "temporary-override-2026",
          pph_final_rate_basis_points: 250,
        },
        {
          issued_at: "2026-12-31",
          id: "temporary-override-2026",
          pph_final_rate_basis_points: 250,
        },
        {
          issued_at: "2027-01-01",
          id: "legacy-open-continuation-2027-01-01",
          pph_final_rate_basis_points: 400,
        },
      ]);

      await runMigrations(client, [originalMigration, correctiveMigration]);
      const rerun = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM tax_rule_versions",
      );
      assert.equal(rerun.rows[0]?.count, 8);
      const appliedMigrations = await client.query<{ name: string }>(
        "SELECT name FROM app_migrations ORDER BY name",
      );
      assert.deepEqual(
        appliedMigrations.rows.map(({ name }) => name),
        [originalMigration.name, correctiveMigration.name],
      );
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

      for (const legacyStatus of ["active", "completed"]) {
        const rejectedUpdate = await fetch(`${firstServer.baseUrl}/projects/${projectId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: legacyStatus }),
        });
        assert.equal(rejectedUpdate.status, 400);
        assert.deepEqual(
          await rejectedUpdate.json(),
          { error: "Data perubahan tidak valid" },
        );
      }

      const [unchangedProject] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, projectId));
      assert.equal(unchangedProject?.status, "BERJALAN");

      await assert.rejects(
        pool.query(
          "UPDATE projects SET status = $1 WHERE id = $2",
          ["STATUS_TIDAK_DIDUKUNG", projectId],
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /projects_status_supported/);
          return true;
        },
      );

      const [projectAfterRejectedDirectWrite] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, projectId));
      assert.equal(projectAfterRejectedDirectWrite?.status, "BERJALAN");
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

  await t.test("successful RAB import remains stored and readable after server restart", async () => {
    const templateId = `test-rab-import-${randomUUID()}`;
    const priceFactor = 1.25;
    const templateItems = [
      {
        code: "TEST.PERSIST.1",
        name: "Pekerjaan persiapan persistensi",
        category: "PERSIAPAN",
        unit: "ls",
        quantity: 2,
        unitPrice: 400_000,
        materialCost: 250_000,
        laborCost: 100_000,
        equipmentCost: 50_000,
        parentCode: null,
        level: 1,
      },
      {
        code: "TEST.PERSIST.1.1",
        name: "Pekerjaan turunan persistensi",
        category: "PERSIAPAN",
        unit: "m2",
        quantity: 3.5,
        unitPrice: 200_000,
        materialCost: 125_000,
        laborCost: 50_000,
        equipmentCost: 25_000,
        parentCode: "TEST.PERSIST.1",
        level: 2,
      },
    ];
    await db.insert(rabTemplatesTable).values({
      id: templateId,
      name: "Template Persistensi Impor RAB",
      projectType: "TEST",
      description: "Fixture unik untuk membuktikan hasil impor tersimpan",
      sourceNote: "Regression test",
      items: templateItems,
    });

    try {
      let importedVersion = 0;
      let newerVersion = 0;
      let importedBaselineId = "";
      const expectedBudgets = [1_000_000, 875_000];
      const expectedTotalBudget = expectedBudgets.reduce((sum, value) => sum + value, 0);
      const newerPriceFactor = 2;
      const newerExpectedBudgets = [1_600_000, 1_400_000];
      const newerExpectedTotalBudget = newerExpectedBudgets.reduce((sum, value) => sum + value, 0);
      const firstServer = await startTestServer();
      try {
        const imported = await requestJson(firstServer.baseUrl, `/projects/${projectId}/rab/import`, {
          method: "POST",
          body: JSON.stringify({ templateId, priceFactor }),
        });
        importedVersion = Number(imported.version);
        assert.equal(imported.status, "DRAF");
        assert.equal(imported.totalBudget, expectedTotalBudget);
        assert.equal((imported.items as unknown[]).length, templateItems.length);

        const [baseline] = await db.select().from(rabBaselinesTable)
          .where(and(
            eq(rabBaselinesTable.projectId, projectId),
            eq(rabBaselinesTable.version, importedVersion),
          ));
        assert.ok(baseline);
        importedBaselineId = baseline.id;
        assert.equal(baseline.status, "DRAF");

        const storedItems = await db.select().from(rabItemsTable)
          .where(eq(rabItemsTable.baselineId, importedBaselineId))
          .orderBy(rabItemsTable.code);
        assert.equal(storedItems.length, templateItems.length);
        assert.deepEqual(storedItems.map(({ code }) => code), templateItems.map(({ code }) => code));
        assert.deepEqual(storedItems.map(({ quantityBasisPoints }) => quantityBasisPoints), [200, 350]);
        assert.deepEqual(storedItems.map(({ unitPrice }) => unitPrice), [500_000, 250_000]);
        assert.deepEqual(storedItems.map(({ budget }) => budget), expectedBudgets);

        const [storedProject] = await db.select().from(projectsTable)
          .where(eq(projectsTable.id, projectId));
        assert.ok(storedProject);
        assert.equal(storedProject.budget, expectedTotalBudget);
        assert.equal(storedProject.wbsCount, templateItems.length);

        const [storedAudit] = await db.select().from(auditLogsTable)
          .where(and(
            eq(auditLogsTable.entity, "RAB"),
            eq(auditLogsTable.entityId, importedBaselineId),
            eq(auditLogsTable.action, "DIIMPOR"),
          ));
        assert.ok(storedAudit);
        assert.equal(storedAudit.actorUserId, access.userId);
        assert.deepEqual(storedAudit.metadata, {
          templateId,
          priceFactor,
          itemCount: templateItems.length,
        });

        const newerImport = await requestJson(firstServer.baseUrl, `/projects/${projectId}/rab/import`, {
          method: "POST",
          body: JSON.stringify({ templateId, priceFactor: newerPriceFactor }),
        });
        newerVersion = Number(newerImport.version);
        assert.equal(newerVersion, importedVersion + 1);
        assert.equal(newerImport.totalBudget, newerExpectedTotalBudget);
      } finally {
        await firstServer.close();
      }

      const restartedServer = await startTestServer();
      try {
        const persisted = await requestJson(restartedServer.baseUrl, `/projects/${projectId}/rab`);
        assert.equal(persisted.projectId, projectId);
        assert.equal(persisted.version, newerVersion);
        assert.equal(persisted.status, "DRAF");
        assert.equal(persisted.totalBudget, newerExpectedTotalBudget);
        assert.equal(persisted.remaining, newerExpectedTotalBudget);
        assert.deepEqual(
          (persisted.items as Array<Record<string, unknown>>).map(({ code, quantity, unitPrice, budget }) => ({
            code,
            quantity,
            unitPrice,
            budget,
          })),
          [
            { code: "TEST.PERSIST.1", quantity: 2, unitPrice: 800_000, budget: newerExpectedBudgets[0] },
            { code: "TEST.PERSIST.1.1", quantity: 3.5, unitPrice: 400_000, budget: newerExpectedBudgets[1] },
          ],
        );

        const versions = await requestJson(restartedServer.baseUrl, `/projects/${projectId}/rab/versions`);
        const listedVersions = versions as unknown as Array<Record<string, unknown>>;
        assert.deepEqual(
          listedVersions.slice(0, 2).map(({ version }) => version),
          [newerVersion, importedVersion],
        );
        assert.ok(listedVersions.every(({ createdAt, updatedAt }) => (
          typeof createdAt === "string" && typeof updatedAt === "string"
        )));

        const olderBaseline = await requestJson(
          restartedServer.baseUrl,
          `/projects/${projectId}/rab/versions/${importedVersion}`,
        );
        const newerBaseline = await requestJson(
          restartedServer.baseUrl,
          `/projects/${projectId}/rab/versions/${newerVersion}`,
        );
        assert.equal(olderBaseline.version, importedVersion);
        assert.equal(olderBaseline.totalBudget, expectedTotalBudget);
        assert.deepEqual(
          (olderBaseline.items as Array<Record<string, unknown>>).map(({ budget }) => budget),
          expectedBudgets,
        );
        assert.equal(newerBaseline.version, newerVersion);
        assert.equal(newerBaseline.totalBudget, newerExpectedTotalBudget);
        assert.deepEqual(
          (newerBaseline.items as Array<Record<string, unknown>>).map(({ budget }) => budget),
          newerExpectedBudgets,
        );

        const latestAfterHistoricalReads = await requestJson(restartedServer.baseUrl, `/projects/${projectId}/rab`);
        assert.equal(latestAfterHistoricalReads.version, newerVersion);
        assert.equal(latestAfterHistoricalReads.totalBudget, newerExpectedTotalBudget);
      } finally {
        await restartedServer.close();
      }

      const restrictedServer = await startTestServer({}, {
        ...access,
        role: "PROJECT_MANAGER",
        assignedProjectIds: ["project-outside-rab-history-test"],
      });
      try {
        const responses = await Promise.all([
          fetch(`${restrictedServer.baseUrl}/projects/${projectId}/rab/versions`),
          fetch(`${restrictedServer.baseUrl}/projects/${projectId}/rab/versions/${importedVersion}`),
        ]);
        assert.deepEqual(responses.map(({ status }) => status), [403, 403]);
      } finally {
        await restrictedServer.close();
      }
    } finally {
      await db.delete(rabTemplatesTable).where(eq(rabTemplatesTable.id, templateId));
    }
  });

  await t.test("concurrent RAB imports receive unique versions without mixing items or audits", async () => {
    const concurrentProjectCode = `TST-${randomUUID().slice(0, 8)}`;
    const templateFixtures = [
      {
        id: `test-rab-import-${randomUUID()}`,
        name: "Template Concurrent RAB Alpha",
        priceFactor: 1.25,
        items: [
          {
            code: "TEST.CONCURRENT.A.1",
            name: "Item Alpha Utama",
            category: "ALPHA",
            unit: "m2",
            quantity: 2,
            unitPrice: 400_000,
            materialCost: 250_000,
            laborCost: 100_000,
            equipmentCost: 50_000,
            parentCode: null,
            level: 1,
          },
          {
            code: "TEST.CONCURRENT.A.2",
            name: "Item Alpha Tambahan",
            category: "ALPHA",
            unit: "ls",
            quantity: 1,
            unitPrice: 300_000,
            materialCost: 200_000,
            laborCost: 75_000,
            equipmentCost: 25_000,
            parentCode: null,
            level: 1,
          },
        ],
      },
      {
        id: `test-rab-import-${randomUUID()}`,
        name: "Template Concurrent RAB Beta",
        priceFactor: 1.1,
        items: [
          {
            code: "TEST.CONCURRENT.B.1",
            name: "Item Beta",
            category: "BETA",
            unit: "m3",
            quantity: 3,
            unitPrice: 250_000,
            materialCost: 150_000,
            laborCost: 75_000,
            equipmentCost: 25_000,
            parentCode: null,
            level: 1,
          },
        ],
      },
    ];
    let concurrentProjectId = "";
    let waitingBeforeLock = 0;
    let releaseVersionLocks!: () => void;
    const bothTransactionsReady = new Promise<void>((resolve) => {
      releaseVersionLocks = resolve;
    });

    await db.insert(rabTemplatesTable).values(templateFixtures.map((template) => ({
      id: template.id,
      name: template.name,
      projectType: "TEST",
      description: "Fixture unik untuk konkurensi impor RAB",
      sourceNote: "Regression test",
      items: template.items,
    })));

    const server = await startTestServer({}, access, {
      beforeRabImportVersionLock: async (hookProjectId) => {
        assert.equal(hookProjectId, concurrentProjectId);
        waitingBeforeLock += 1;
        if (waitingBeforeLock === templateFixtures.length) releaseVersionLocks();
        await bothTransactionsReady;
      },
    });

    try {
      const created = await requestJson(server.baseUrl, "/projects", {
        method: "POST",
        body: JSON.stringify({
          code: concurrentProjectCode,
          name: "Proyek Concurrent RAB",
          owner: "Regression Test",
          contractValue: 100_000_000,
          endDate: "2027-12-31",
        }),
      });
      concurrentProjectId = String(created.id);

      const imports = await Promise.all(templateFixtures.map((template) =>
        requestJson(server.baseUrl, `/projects/${concurrentProjectId}/rab/import`, {
          method: "POST",
          body: JSON.stringify({
            templateId: template.id,
            priceFactor: template.priceFactor,
          }),
        })
      ));

      assert.equal(waitingBeforeLock, templateFixtures.length);
      const importsByTemplateId = new Map(templateFixtures.map((template, index) => [
        template.id,
        { response: imports[index], template },
      ]));
      const importedVersions = imports.map(({ version }) => Number(version)).sort((a, b) => a - b);
      assert.equal(new Set(importedVersions).size, templateFixtures.length);
      assert.equal(importedVersions[1], importedVersions[0] + 1);

      const baselines = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.projectId, concurrentProjectId));
      const importedBaselines = baselines.filter(({ version }) => importedVersions.includes(version));
      assert.equal(importedBaselines.length, templateFixtures.length);

      for (const baseline of importedBaselines) {
        const [audit] = await db.select().from(auditLogsTable).where(and(
          eq(auditLogsTable.entity, "RAB"),
          eq(auditLogsTable.entityId, baseline.id),
          eq(auditLogsTable.action, "DIIMPOR"),
        ));
        assert.ok(audit);
        const templateId = String((audit.metadata as Record<string, unknown>).templateId);
        const fixture = importsByTemplateId.get(templateId);
        assert.ok(fixture);
        assert.equal(Number(fixture.response.version), baseline.version);
        assert.equal(audit.detail, `${fixture.template.name} menjadi RAB ${concurrentProjectCode} versi ${baseline.version}`);
        assert.deepEqual(audit.metadata, {
          templateId,
          priceFactor: fixture.template.priceFactor,
          itemCount: fixture.template.items.length,
        });

        const storedItems = await db.select().from(rabItemsTable)
          .where(eq(rabItemsTable.baselineId, baseline.id))
          .orderBy(rabItemsTable.code);
        assert.deepEqual(
          storedItems.map(({ code }) => code),
          fixture.template.items.map(({ code }) => code),
        );
        assert.ok(storedItems.every(({ baselineId }) => baselineId === baseline.id));
        assert.equal(
          storedItems.reduce((sum, { budget }) => sum + budget, 0),
          Number(fixture.response.totalBudget),
        );
      }

      const latestBaseline = importedBaselines.find(({ version }) => version === importedVersions[1]);
      assert.ok(latestBaseline);
      const [latestAudit] = await db.select().from(auditLogsTable)
        .where(eq(auditLogsTable.entityId, latestBaseline.id));
      assert.ok(latestAudit);
      const latestFixture = importsByTemplateId.get(
        String((latestAudit.metadata as Record<string, unknown>).templateId),
      );
      assert.ok(latestFixture);
      const [storedProject] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, concurrentProjectId));
      assert.ok(storedProject);
      assert.equal(storedProject.budget, Number(latestFixture.response.totalBudget));
      assert.equal(storedProject.wbsCount, latestFixture.template.items.length);
    } finally {
      releaseVersionLocks();
      await server.close();
      await db.transaction(async (tx) => {
        if (concurrentProjectId) {
          const baselines = await tx.select({ id: rabBaselinesTable.id })
            .from(rabBaselinesTable)
            .where(eq(rabBaselinesTable.projectId, concurrentProjectId));
          const entityIds = [concurrentProjectId, ...baselines.map(({ id }) => id)];
          await tx.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, entityIds));
          await tx.delete(projectsTable).where(eq(projectsTable.id, concurrentProjectId));
        }
        await tx.delete(rabTemplatesTable).where(inArray(
          rabTemplatesTable.id,
          templateFixtures.map(({ id }) => id),
        ));
      });
    }
  });

  await t.test("a failed concurrent RAB import rolls back without blocking the other import", async () => {
    const concurrentProjectCode = `TST-${randomUUID().slice(0, 8)}`;
    const failedTemplate = {
      id: `test-rab-import-${randomUUID()}`,
      name: "Template Concurrent RAB Gagal",
      priceFactor: 1.2,
      items: [{
        code: "TEST.CONCURRENT.FAIL.1",
        name: "Item transaksi gagal",
        category: "GAGAL",
        unit: "ls",
        quantity: 4,
        unitPrice: 125_000,
        materialCost: 75_000,
        laborCost: 40_000,
        equipmentCost: 10_000,
        parentCode: null,
        level: 1,
      }],
    };
    const successfulTemplate = {
      id: `test-rab-import-${randomUUID()}`,
      name: "Template Concurrent RAB Berhasil",
      priceFactor: 1.25,
      items: [
        {
          code: "TEST.CONCURRENT.SUCCESS.1",
          name: "Item sukses utama",
          category: "SUKSES",
          unit: "m2",
          quantity: 2,
          unitPrice: 400_000,
          materialCost: 250_000,
          laborCost: 100_000,
          equipmentCost: 50_000,
          parentCode: null,
          level: 1,
        },
        {
          code: "TEST.CONCURRENT.SUCCESS.2",
          name: "Item sukses tambahan",
          category: "SUKSES",
          unit: "ls",
          quantity: 3,
          unitPrice: 200_000,
          materialCost: 125_000,
          laborCost: 50_000,
          equipmentCost: 25_000,
          parentCode: null,
          level: 1,
        },
      ],
    };
    const templateFixtures = [failedTemplate, successfulTemplate];
    let concurrentProjectId = "";
    let failedBaselineId = "";
    let failedVersion = 0;
    let resolveFailedImportAfterVersion!: () => void;
    const failedImportAfterVersion = new Promise<void>((resolve) => {
      resolveFailedImportAfterVersion = resolve;
    });
    let resolveSuccessfulImportBeforeLock!: () => void;
    const successfulImportBeforeLock = new Promise<void>((resolve) => {
      resolveSuccessfulImportBeforeLock = resolve;
    });

    await db.insert(rabTemplatesTable).values(templateFixtures.map((template) => ({
      id: template.id,
      name: template.name,
      projectType: "TEST",
      description: "Fixture unik untuk konkurensi impor RAB dengan satu kegagalan",
      sourceNote: "Regression test",
      items: template.items,
    })));

    const setupServer = await startTestServer();
    let failedServer: Awaited<ReturnType<typeof startTestServer>> | undefined;
    let successfulServer: Awaited<ReturnType<typeof startTestServer>> | undefined;
    try {
      const created = await requestJson(setupServer.baseUrl, "/projects", {
        method: "POST",
        body: JSON.stringify({
          code: concurrentProjectCode,
          name: "Proyek Concurrent RAB dengan Kegagalan",
          owner: "Regression Test",
          contractValue: 100_000_000,
          endDate: "2027-12-31",
        }),
      });
      concurrentProjectId = String(created.id);
      await setupServer.close();

      failedServer = await startTestServer({}, access, {
        beforeRabImportAuditInsert: async (hookProjectId, baselineId, version) => {
          assert.equal(hookProjectId, concurrentProjectId);
          failedBaselineId = baselineId;
          failedVersion = version;
          resolveFailedImportAfterVersion();
          await successfulImportBeforeLock;
          throw new Error("Injected concurrent RAB import failure");
        },
      });
      successfulServer = await startTestServer({}, access, {
        beforeRabImportVersionLock: async (hookProjectId) => {
          assert.equal(hookProjectId, concurrentProjectId);
          resolveSuccessfulImportBeforeLock();
          await failedImportAfterVersion;
        },
      });

      const failedImportPromise = fetch(`${failedServer.baseUrl}/projects/${concurrentProjectId}/rab/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId: failedTemplate.id,
          priceFactor: failedTemplate.priceFactor,
        }),
      });
      await failedImportAfterVersion;
      const successfulImportPromise = requestJson(
        successfulServer.baseUrl,
        `/projects/${concurrentProjectId}/rab/import`,
        {
          method: "POST",
          body: JSON.stringify({
            templateId: successfulTemplate.id,
            priceFactor: successfulTemplate.priceFactor,
          }),
        },
      );
      const [failedResponse, successfulImport] = await Promise.all([
        failedImportPromise,
        successfulImportPromise,
      ]);

      assert.equal(failedResponse.status, 500);
      assert.notEqual(failedBaselineId, "");
      assert.ok(failedVersion > 1);
      assert.equal(Number(successfulImport.version), failedVersion);
      const expectedBudgets = [1_000_000, 750_000];
      const expectedTotalBudget = expectedBudgets.reduce((sum, budget) => sum + budget, 0);
      assert.equal(successfulImport.totalBudget, expectedTotalBudget);

      const [successfulBaseline] = await db.select().from(rabBaselinesTable)
        .where(and(
          eq(rabBaselinesTable.projectId, concurrentProjectId),
          eq(rabBaselinesTable.version, Number(successfulImport.version)),
        ));
      assert.ok(successfulBaseline);
      assert.notEqual(successfulBaseline.id, failedBaselineId);
      const storedItems = await db.select().from(rabItemsTable)
        .where(eq(rabItemsTable.baselineId, successfulBaseline.id))
        .orderBy(rabItemsTable.code);
      assert.deepEqual(
        storedItems.map(({ code }) => code),
        successfulTemplate.items.map(({ code }) => code),
      );
      assert.deepEqual(storedItems.map(({ budget }) => budget), expectedBudgets);

      const [storedProject] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, concurrentProjectId));
      assert.ok(storedProject);
      assert.equal(storedProject.budget, expectedTotalBudget);
      assert.equal(storedProject.wbsCount, successfulTemplate.items.length);

      const [successfulAudit] = await db.select().from(auditLogsTable).where(and(
        eq(auditLogsTable.entity, "RAB"),
        eq(auditLogsTable.entityId, successfulBaseline.id),
        eq(auditLogsTable.action, "DIIMPOR"),
      ));
      assert.ok(successfulAudit);
      assert.equal(
        successfulAudit.detail,
        `${successfulTemplate.name} menjadi RAB ${concurrentProjectCode} versi ${successfulImport.version}`,
      );
      assert.deepEqual(successfulAudit.metadata, {
        templateId: successfulTemplate.id,
        priceFactor: successfulTemplate.priceFactor,
        itemCount: successfulTemplate.items.length,
      });

      const [failedBaseline] = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.id, failedBaselineId));
      const failedItems = await db.select().from(rabItemsTable)
        .where(eq(rabItemsTable.baselineId, failedBaselineId));
      const [failedAudit] = await db.select().from(auditLogsTable)
        .where(eq(auditLogsTable.entityId, failedBaselineId));
      assert.equal(failedBaseline, undefined);
      assert.deepEqual(failedItems, []);
      assert.equal(failedAudit, undefined);
    } finally {
      resolveFailedImportAfterVersion();
      resolveSuccessfulImportBeforeLock();
      await Promise.allSettled([
        setupServer.close(),
        failedServer?.close(),
        successfulServer?.close(),
      ]);
      await db.transaction(async (tx) => {
        if (concurrentProjectId) {
          const baselines = await tx.select({ id: rabBaselinesTable.id })
            .from(rabBaselinesTable)
            .where(eq(rabBaselinesTable.projectId, concurrentProjectId));
          const entityIds = [concurrentProjectId, failedBaselineId, ...baselines.map(({ id }) => id)]
            .filter(Boolean);
          await tx.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, entityIds));
          await tx.delete(projectsTable).where(eq(projectsTable.id, concurrentProjectId));
        }
        await tx.delete(rabTemplatesTable).where(inArray(
          rabTemplatesTable.id,
          templateFixtures.map(({ id }) => id),
        ));
      });
    }
  });

  await t.test("separate API processes keep a failed and successful concurrent RAB import atomic", async () => {
    const concurrentProjectCode = `TST-${randomUUID().slice(0, 8)}`;
    const failedTemplate = {
      id: `test-rab-import-${randomUUID()}`,
      name: "Template Process RAB Gagal",
      priceFactor: 1.2,
      items: [{
        code: "TEST.PROCESS.FAIL.1",
        name: "Item proses gagal",
        category: "GAGAL",
        unit: "ls",
        quantity: 4,
        unitPrice: 125_000,
        materialCost: 75_000,
        laborCost: 40_000,
        equipmentCost: 10_000,
        parentCode: null,
        level: 1,
      }],
    };
    const successfulTemplate = {
      id: `test-rab-import-${randomUUID()}`,
      name: "Template Process RAB Berhasil",
      priceFactor: 1.25,
      items: [
        {
          code: "TEST.PROCESS.SUCCESS.1",
          name: "Item proses sukses utama",
          category: "SUKSES",
          unit: "m2",
          quantity: 2,
          unitPrice: 400_000,
          materialCost: 250_000,
          laborCost: 100_000,
          equipmentCost: 50_000,
          parentCode: null,
          level: 1,
        },
        {
          code: "TEST.PROCESS.SUCCESS.2",
          name: "Item proses sukses tambahan",
          category: "SUKSES",
          unit: "ls",
          quantity: 3,
          unitPrice: 200_000,
          materialCost: 125_000,
          laborCost: 50_000,
          equipmentCost: 25_000,
          parentCode: null,
          level: 1,
        },
      ],
    };
    const templateFixtures = [failedTemplate, successfulTemplate];
    let concurrentProjectId = "";
    let failedWorker: ReturnType<typeof startRabImportProcess> | undefined;
    let successfulWorker: ReturnType<typeof startRabImportProcess> | undefined;
    const setupServer = await startTestServer();

    await db.insert(rabTemplatesTable).values(templateFixtures.map((template) => ({
      id: template.id,
      name: template.name,
      projectType: "TEST",
      description: "Fixture unik untuk konkurensi impor RAB lintas proses",
      sourceNote: "Regression test",
      items: template.items,
    })));

    try {
      const created = await requestJson(setupServer.baseUrl, "/projects", {
        method: "POST",
        body: JSON.stringify({
          code: concurrentProjectCode,
          name: "Proyek Concurrent RAB Lintas Proses",
          owner: "Regression Test",
          contractValue: 100_000_000,
          endDate: "2027-12-31",
        }),
      });
      concurrentProjectId = String(created.id);
      await setupServer.close();

      failedWorker = startRabImportProcess(
        "fail",
        concurrentProjectId,
        failedTemplate.id,
        failedTemplate.priceFactor,
      );
      successfulWorker = startRabImportProcess(
        "succeed",
        concurrentProjectId,
        successfulTemplate.id,
        successfulTemplate.priceFactor,
      );
      await Promise.all([
        waitForWorkerOutput(failedWorker.child, /^READY \d+$/m, failedWorker.stdout),
        waitForWorkerOutput(successfulWorker.child, /^READY \d+$/m, successfulWorker.stdout),
      ]);

      failedWorker.child.stdin.write("START\n");
      const failedVersionMatch = await waitForWorkerOutput(
        failedWorker.child,
        /^AFTER_VERSION ([0-9a-f-]+) (\d+)$/m,
        failedWorker.stdout,
      );
      const failedBaselineId = failedVersionMatch[1]!;
      const failedVersion = Number(failedVersionMatch[2]);

      successfulWorker.child.stdin.write("START\n");
      await waitForWorkerOutput(successfulWorker.child, /^BEFORE_LOCK$/m, successfulWorker.stdout);
      failedWorker.child.stdin.write("CONTINUE\n");
      successfulWorker.child.stdin.write("CONTINUE\n");

      const [failedResultMatch, successfulResultMatch] = await Promise.all([
        waitForWorkerOutput(failedWorker.child, /^RESULT (\d+) ([A-Za-z0-9+/=]+)$/m, failedWorker.stdout),
        waitForWorkerOutput(successfulWorker.child, /^RESULT (\d+) ([A-Za-z0-9+/=]+)$/m, successfulWorker.stdout),
      ]);
      const [failedExit, successfulExit] = await Promise.all([
        failedWorker.result,
        successfulWorker.result,
      ]);
      assert.equal(failedExit.code, 0, failedWorker.stderr());
      assert.equal(successfulExit.code, 0, successfulWorker.stderr());
      assert.equal(Number(failedResultMatch[1]), 500);
      assert.equal(Number(successfulResultMatch[1]), 201);
      const successfulImport = JSON.parse(
        Buffer.from(successfulResultMatch[2]!, "base64").toString("utf8"),
      ) as Record<string, unknown>;
      assert.equal(Number(successfulImport.version), failedVersion);

      const baselines = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.projectId, concurrentProjectId));
      assert.equal(baselines.length, 2);
      const successfulBaseline = baselines.find(({ version }) => version === failedVersion);
      assert.ok(successfulBaseline);
      assert.notEqual(successfulBaseline.id, failedBaselineId);

      const expectedBudgets = [1_000_000, 750_000];
      const expectedTotalBudget = expectedBudgets.reduce((sum, budget) => sum + budget, 0);
      const storedItems = await db.select().from(rabItemsTable)
        .where(eq(rabItemsTable.baselineId, successfulBaseline.id))
        .orderBy(rabItemsTable.code);
      assert.deepEqual(storedItems.map(({ code }) => code), successfulTemplate.items.map(({ code }) => code));
      assert.deepEqual(storedItems.map(({ budget }) => budget), expectedBudgets);

      const [storedProject] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, concurrentProjectId));
      assert.ok(storedProject);
      assert.equal(storedProject.budget, expectedTotalBudget);
      assert.equal(storedProject.wbsCount, successfulTemplate.items.length);

      const successfulAudits = await db.select().from(auditLogsTable).where(and(
        eq(auditLogsTable.entity, "RAB"),
        eq(auditLogsTable.entityId, successfulBaseline.id),
        eq(auditLogsTable.action, "DIIMPOR"),
      ));
      assert.equal(successfulAudits.length, 1);
      assert.deepEqual(successfulAudits[0]!.metadata, {
        templateId: successfulTemplate.id,
        priceFactor: successfulTemplate.priceFactor,
        itemCount: successfulTemplate.items.length,
      });

      const [failedBaseline] = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.id, failedBaselineId));
      const failedItems = await db.select().from(rabItemsTable)
        .where(eq(rabItemsTable.baselineId, failedBaselineId));
      const failedAudits = await db.select().from(auditLogsTable)
        .where(eq(auditLogsTable.entityId, failedBaselineId));
      assert.equal(failedBaseline, undefined);
      assert.deepEqual(failedItems, []);
      assert.deepEqual(failedAudits, []);
    } finally {
      failedWorker?.child.stdin.write("CONTINUE\n");
      successfulWorker?.child.stdin.write("CONTINUE\n");
      await Promise.allSettled([
        setupServer.close(),
        ...(failedWorker ? [stopRabImportProcess(failedWorker)] : []),
        ...(successfulWorker ? [stopRabImportProcess(successfulWorker)] : []),
      ]);
      await db.transaction(async (tx) => {
        if (concurrentProjectId) {
          const baselines = await tx.select({ id: rabBaselinesTable.id })
            .from(rabBaselinesTable)
            .where(eq(rabBaselinesTable.projectId, concurrentProjectId));
          await tx.delete(auditLogsTable).where(inArray(
            auditLogsTable.entityId,
            [concurrentProjectId, ...baselines.map(({ id }) => id)],
          ));
          await tx.delete(projectsTable).where(eq(projectsTable.id, concurrentProjectId));
        }
        await tx.delete(rabTemplatesTable).where(inArray(
          rabTemplatesTable.id,
          templateFixtures.map(({ id }) => id),
        ));
      });
    }
  });

  await t.test("a RAB import lock timeout returns a retryable response without partial writes", async () => {
    const lockedProjectCode = `TST-${randomUUID().slice(0, 8)}`;
    const template = {
      id: `test-rab-import-${randomUUID()}`,
      name: "Template RAB Lock Timeout",
      items: [{
        code: "TEST.LOCK.TIMEOUT.1",
        name: "Item yang tidak boleh tersimpan",
        category: "TEST",
        unit: "ls",
        quantity: 2,
        unitPrice: 500_000,
        materialCost: 300_000,
        laborCost: 150_000,
        equipmentCost: 50_000,
        parentCode: null,
        level: 1,
      }],
    };
    let lockedProjectId = "";
    let attemptedBaselineId = "";
    const lockClient = await pool.connect();
    const server = await startTestServer({}, access, {
      rabImportLockTimeoutMs: 100,
      beforeRabImportVersionLock: async (_projectId, baselineId) => {
        attemptedBaselineId = baselineId;
      },
    });

    try {
      await db.insert(rabTemplatesTable).values({
        id: template.id,
        name: template.name,
        projectType: "TEST",
        description: "Fixture timeout advisory lock impor RAB",
        sourceNote: "Regression test",
        items: template.items,
      });
      const created = await requestJson(server.baseUrl, "/projects", {
        method: "POST",
        body: JSON.stringify({
          code: lockedProjectCode,
          name: "Proyek RAB Lock Timeout",
          owner: "Regression Test",
          contractValue: 100_000_000,
          endDate: "2027-12-31",
        }),
      });
      lockedProjectId = String(created.id);
      const [beforeProject] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, lockedProjectId));
      const beforeBaselines = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.projectId, lockedProjectId));

      await lockClient.query("begin");
      await lockClient.query("select pg_advisory_xact_lock(hashtext($1))", [lockedProjectId]);
      const startedAt = Date.now();
      const response = await fetch(`${server.baseUrl}/projects/${lockedProjectId}/rab/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: template.id, priceFactor: 1 }),
      });
      const elapsedMs = Date.now() - startedAt;
      const responseBody = await response.json() as Record<string, unknown>;

      assert.equal(response.status, 503);
      assert.equal(responseBody.retryable, true);
      assert.match(String(responseBody.error), /Coba lagi/);
      assert.ok(elapsedMs >= 75, `lock timeout returned too early after ${elapsedMs}ms`);
      assert.ok(elapsedMs < 2_000, `lock timeout took too long: ${elapsedMs}ms`);
      assert.notEqual(attemptedBaselineId, "");

      const [afterProject] = await db.select().from(projectsTable)
        .where(eq(projectsTable.id, lockedProjectId));
      const afterBaselines = await db.select().from(rabBaselinesTable)
        .where(eq(rabBaselinesTable.projectId, lockedProjectId));
      const attemptedItems = await db.select().from(rabItemsTable)
        .where(eq(rabItemsTable.baselineId, attemptedBaselineId));
      const attemptedAudits = await db.select().from(auditLogsTable)
        .where(eq(auditLogsTable.entityId, attemptedBaselineId));

      assert.deepEqual(afterProject, beforeProject);
      assert.deepEqual(afterBaselines, beforeBaselines);
      assert.deepEqual(attemptedItems, []);
      assert.deepEqual(attemptedAudits, []);
    } finally {
      await lockClient.query("rollback").catch(() => undefined);
      lockClient.release();
      await server.close();
      await db.transaction(async (tx) => {
        if (lockedProjectId) {
          const baselines = await tx.select({ id: rabBaselinesTable.id })
            .from(rabBaselinesTable)
            .where(eq(rabBaselinesTable.projectId, lockedProjectId));
          await tx.delete(auditLogsTable).where(inArray(
            auditLogsTable.entityId,
            [lockedProjectId, attemptedBaselineId, ...baselines.map(({ id }) => id)].filter(Boolean),
          ));
          await tx.delete(projectsTable).where(eq(projectsTable.id, lockedProjectId));
        }
        await tx.delete(rabTemplatesTable).where(eq(rabTemplatesTable.id, template.id));
      });
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

  await t.test("tax summary defaults to the Asia/Jakarta month when UTC is still in the previous month", async () => {
    mock.timers.enable({
      apis: ["Date"],
      now: new Date("2031-01-31T18:00:00.000Z"),
    });
    const server = await startTestServer();
    try {
      const summary = await requestJson(server.baseUrl, "/tax/summary");
      assert.equal(summary.period, "2031-02");
    } finally {
      await server.close();
      mock.timers.reset();
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
      assert.deepEqual(summary.reconciliationDetails, []);

      await db.update(taxCalculationSnapshotsTable)
        .set({ ppn: Number(otherService.ppn) - 100_000 })
        .where(eq(taxCalculationSnapshotsTable.invoiceId, String(otherService.id)));

      const summaryWithVariance = await requestJson(server.baseUrl, "/tax/summary?period=2098-05");
      assert.equal(summaryWithVariance.subLedgerTotal, 8_150_200);
      assert.equal(summaryWithVariance.reconciliation, 8_150_200 / 8_250_200);
      assert.deepEqual(summaryWithVariance.reconciliationDetails, [{
        invoiceId: otherService.id,
        invoiceNumber: otherService.number,
        projectName: otherService.projectName,
        issuedAt: otherService.issuedAt,
        ledgerTax: Number(otherService.ppn) + Number(otherService.pphFinal) + Number(otherService.pph23),
        snapshotTax: Number(otherService.ppn) + Number(otherService.pphFinal) + Number(otherService.pph23) - 100_000,
        variance: 100_000,
      }]);

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
      const zeroLedgerDetails = zeroLedgerWithVariance.reconciliationDetails;
      assert.ok(Array.isArray(zeroLedgerDetails));
      assert.equal(zeroLedgerDetails.length, 1);
      assert.equal(zeroLedgerDetails[0].invoiceId, outsidePeriod.id);
      assert.equal(zeroLedgerDetails[0].ledgerTax, 0);
      assert.equal(zeroLedgerDetails[0].snapshotTax, 100_000);
      assert.equal(zeroLedgerDetails[0].variance, -100_000);

      const emptyMonth = await requestJson(server.baseUrl, "/tax/summary?period=2098-07");
      assert.equal(emptyMonth.pphFinal, 0);
      assert.equal(emptyMonth.ppn, 0);
      assert.equal(emptyMonth.pph23, 0);
      assert.equal(emptyMonth.total, 0);
      assert.equal(emptyMonth.subLedgerTotal, 0);
      assert.equal(emptyMonth.documents, 0);
      assert.equal(emptyMonth.reconciliation, 1);
      assert.deepEqual(emptyMonth.reconciliationDetails, []);
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
  }, databaseSuiteName, databaseStatementTimeoutMs);
});