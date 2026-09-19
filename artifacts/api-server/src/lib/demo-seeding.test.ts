import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  invoicesTable,
  projectsTable,
  taxCalculationSnapshotsTable,
} from "@workspace/db";
import {
  acquirePersistenceDatabaseSuiteLock,
  defaultDatabaseSuiteStatementTimeoutMs,
  describeDatabaseSuiteError,
  releasePersistenceDatabaseSuiteLock,
  runDatabaseSuiteOperation,
  setDatabaseSuitePoolStatementTimeout,
  type DatabaseSuiteLockClient,
} from "../testing/database-suite-lock";
import { demoInvoices, seedDemoData } from "./demo-data";
import { shouldSeedDemoData } from "./demo-seeding";

const runId = randomUUID();
const nonDemoProjectId = `test-demo-seed-project-${runId}`;
const nonDemoInvoiceId = `test-demo-seed-invoice-${runId}`;
const nonDemoSnapshotId = `test-demo-seed-snapshot-${runId}`;
const collidingInvoiceId = demoInvoices[0].id;
const collidingSnapshotId = `tax-${collidingInvoiceId}`;
let databaseSuiteLockClient: DatabaseSuiteLockClient | undefined;
const databaseSuiteName = "Demo seeding suite";
const databaseStatementTimeoutMs = Number(
  process.env.DEMO_SEEDING_TEST_STATEMENT_TIMEOUT_MS ?? defaultDatabaseSuiteStatementTimeoutMs,
);

before(async () => {
  setDatabaseSuitePoolStatementTimeout(databaseSuiteName, databaseStatementTimeoutMs);
  await runDatabaseSuiteOperation(async () => {
    databaseSuiteLockClient = await acquirePersistenceDatabaseSuiteLock();
  }, databaseSuiteName, databaseStatementTimeoutMs);
});

after(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    try {
      await db.delete(taxCalculationSnapshotsTable)
        .where(eq(taxCalculationSnapshotsTable.id, nonDemoSnapshotId));
      await db.delete(taxCalculationSnapshotsTable)
        .where(eq(taxCalculationSnapshotsTable.id, collidingSnapshotId));
      await db.delete(invoicesTable).where(eq(invoicesTable.id, nonDemoInvoiceId));
      await db.delete(invoicesTable).where(eq(invoicesTable.id, collidingInvoiceId));
      await db.delete(projectsTable).where(eq(projectsTable.id, nonDemoProjectId));
    } catch (error) {
      cleanupErrors.push(describeDatabaseSuiteError(error, databaseSuiteName, databaseStatementTimeoutMs));
    }
  } finally {
    if (databaseSuiteLockClient) {
      try {
        await releasePersistenceDatabaseSuiteLock(databaseSuiteLockClient);
      } catch (error) {
        cleanupErrors.push(describeDatabaseSuiteError(error, databaseSuiteName, databaseStatementTimeoutMs));
      }
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `${databaseSuiteName} cleanup or lock release failed`);
  }
});

test("demo seeding does not change non-demo rows that collide with fixture IDs", async () => {
  await runDatabaseSuiteOperation(async () => {
  await seedDemoData();
  await db.delete(taxCalculationSnapshotsTable)
    .where(eq(taxCalculationSnapshotsTable.id, collidingSnapshotId));
  await db.delete(invoicesTable).where(eq(invoicesTable.id, collidingInvoiceId));

  await db.insert(invoicesTable).values({
    id: collidingInvoiceId,
    number: `INV/COLLISION/${runId}`,
    projectId: "prj-001",
    projectCode: "USER-OWNED",
    projectName: "User-owned collision",
    period: "September 2026",
    dpp: 2_000_000,
    ppn: 220_000,
    pphFinal: 50_000,
    retention: 100_000,
    total: 2_070_000,
    status: "DRAFT",
    issuedAt: "2026-09-17",
    taxRuleVersionId: null,
    fixtureOwner: null,
  });

  const [invoiceBeforeSeedWithoutSnapshot] = await db.select().from(invoicesTable)
    .where(eq(invoicesTable.id, collidingInvoiceId));
  await seedDemoData();
  const [invoiceAfterSeedWithoutSnapshot] = await db.select().from(invoicesTable)
    .where(eq(invoicesTable.id, collidingInvoiceId));
  const [snapshotAfterSeedWithoutSnapshot] = await db.select()
    .from(taxCalculationSnapshotsTable)
    .where(eq(taxCalculationSnapshotsTable.id, collidingSnapshotId));
  assert.deepEqual(invoiceAfterSeedWithoutSnapshot, invoiceBeforeSeedWithoutSnapshot);
  assert.equal(snapshotAfterSeedWithoutSnapshot, undefined);

  await db.insert(taxCalculationSnapshotsTable).values({
    id: collidingSnapshotId,
    invoiceId: collidingInvoiceId,
    taxRuleVersionId: null,
    fixtureOwner: null,
    ruleVersion: "USER-OWNED",
    regulatorySource: "User-owned collision regression fixture",
    ruleSnapshot: { fixture: "user-owned" },
    dpp: 2_000_000,
    integrated: false,
    dppLainRateBasisPoints: 10_000,
    ppnRateBasisPoints: 1_100,
    pphRateBasisPoints: 250,
    retentionPercentBasisPoints: 500,
    ppn: 220_000,
    pphFinal: 50_000,
    retention: 100_000,
  });

  const [snapshotBefore] = await db.select().from(taxCalculationSnapshotsTable)
    .where(eq(taxCalculationSnapshotsTable.id, collidingSnapshotId));

  await seedDemoData();

  const [invoiceAfter] = await db.select().from(invoicesTable)
    .where(eq(invoicesTable.id, collidingInvoiceId));
  const [snapshotAfter] = await db.select().from(taxCalculationSnapshotsTable)
    .where(eq(taxCalculationSnapshotsTable.id, collidingSnapshotId));
  assert.deepEqual(invoiceAfter, invoiceBeforeSeedWithoutSnapshot);
  assert.deepEqual(snapshotAfter, snapshotBefore);

  await db.delete(taxCalculationSnapshotsTable)
    .where(eq(taxCalculationSnapshotsTable.id, collidingSnapshotId));
  await db.delete(invoicesTable).where(eq(invoicesTable.id, collidingInvoiceId));
  await seedDemoData();
  }, databaseSuiteName, databaseStatementTimeoutMs);
});

test("demo data seeding requires development mode and explicit opt-in", () => {
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: "development", SEED_DEMO_DATA: "true" }),
    true,
  );
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: "development", SEED_DEMO_DATA: undefined }),
    false,
  );
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: "development", SEED_DEMO_DATA: "false" }),
    false,
  );
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: "production", SEED_DEMO_DATA: "true" }),
    false,
  );
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: undefined, SEED_DEMO_DATA: "true" }),
    false,
  );
});

test("demo seeding is idempotent and leaves non-demo tax references unchanged", async () => {
  await runDatabaseSuiteOperation(async () => {
  await seedDemoData();

  await db.insert(projectsTable).values({
    id: nonDemoProjectId,
    code: `TDS-${runId.slice(0, 8)}`,
    name: "Non-demo seed regression project",
    owner: "Regression test",
    contractValue: 1_000_000,
    endDate: "2026-12-31",
  });
  await db.insert(invoicesTable).values({
    id: nonDemoInvoiceId,
    number: `INV/NON-DEMO/${runId}`,
    projectId: nonDemoProjectId,
    projectCode: `TDS-${runId.slice(0, 8)}`,
    projectName: "Non-demo seed regression project",
    period: "September 2026",
    dpp: 1_000_000,
    ppn: 110_000,
    pphFinal: 25_000,
    retention: 50_000,
    total: 1_035_000,
    status: "DRAFT",
    issuedAt: "2026-09-16",
    taxRuleVersionId: null,
  });
  await db.insert(taxCalculationSnapshotsTable).values({
    id: nonDemoSnapshotId,
    invoiceId: nonDemoInvoiceId,
    taxRuleVersionId: null,
    ruleVersion: "NON-DEMO-LEGACY",
    regulatorySource: "Non-demo regression fixture",
    ruleSnapshot: { fixture: "non-demo" },
    dpp: 1_000_000,
    integrated: false,
    dppLainRateBasisPoints: 10_000,
    ppnRateBasisPoints: 1_100,
    pphRateBasisPoints: 250,
    retentionPercentBasisPoints: 500,
    ppn: 110_000,
    pphFinal: 25_000,
    retention: 50_000,
  });

  const demoIds = demoInvoices.map(({ id }) => id);
  const demoSnapshotIds = demoIds.map((id) => `tax-${id}`);
  await db.update(invoicesTable)
    .set({
      taxRuleVersionId: null,
      fixtureOwner: "construction-erp-demo-v1",
    })
    .where(inArray(invoicesTable.id, demoIds));
  await db.update(taxCalculationSnapshotsTable)
    .set({
      taxRuleVersionId: null,
      fixtureOwner: "construction-erp-demo-v1",
    })
    .where(inArray(taxCalculationSnapshotsTable.id, demoSnapshotIds));

  await seedDemoData();

  const [nonDemoInvoiceAfterFirstSeed] = await db.select().from(invoicesTable)
    .where(eq(invoicesTable.id, nonDemoInvoiceId));
  const [nonDemoSnapshotAfterFirstSeed] = await db.select().from(taxCalculationSnapshotsTable)
    .where(eq(taxCalculationSnapshotsTable.id, nonDemoSnapshotId));
  const demoInvoicesAfterFirstSeed = await db.select().from(invoicesTable)
    .where(inArray(invoicesTable.id, demoIds));
  const demoSnapshotsAfterFirstSeed = await db.select().from(taxCalculationSnapshotsTable)
    .where(inArray(taxCalculationSnapshotsTable.id, demoSnapshotIds));

  assert.equal(nonDemoInvoiceAfterFirstSeed?.taxRuleVersionId, null);
  assert.equal(nonDemoSnapshotAfterFirstSeed?.taxRuleVersionId, null);
  assert.equal(nonDemoSnapshotAfterFirstSeed?.ruleVersion, "NON-DEMO-LEGACY");
  assert.deepEqual(nonDemoSnapshotAfterFirstSeed?.ruleSnapshot, { fixture: "non-demo" });
  assert.ok(demoInvoicesAfterFirstSeed.every(
    ({ taxRuleVersionId }) => taxRuleVersionId === "tax-legacy-demo-2026",
  ));
  assert.ok(demoSnapshotsAfterFirstSeed.every(
    ({ taxRuleVersionId }) => taxRuleVersionId === "tax-legacy-demo-2026",
  ));

  await seedDemoData();

  const [nonDemoInvoiceAfterSecondSeed] = await db.select().from(invoicesTable)
    .where(eq(invoicesTable.id, nonDemoInvoiceId));
  const [nonDemoSnapshotAfterSecondSeed] = await db.select().from(taxCalculationSnapshotsTable)
    .where(eq(taxCalculationSnapshotsTable.id, nonDemoSnapshotId));
  assert.deepEqual(nonDemoInvoiceAfterSecondSeed, nonDemoInvoiceAfterFirstSeed);
  assert.deepEqual(nonDemoSnapshotAfterSecondSeed, nonDemoSnapshotAfterFirstSeed);
  }, databaseSuiteName, databaseStatementTimeoutMs);
});
