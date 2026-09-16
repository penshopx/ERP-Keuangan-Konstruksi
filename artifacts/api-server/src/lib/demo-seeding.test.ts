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
  releasePersistenceDatabaseSuiteLock,
  type DatabaseSuiteLockClient,
} from "../testing/database-suite-lock";
import { demoInvoices, seedDemoData } from "./demo-data";
import { shouldSeedDemoData } from "./demo-seeding";

const runId = randomUUID();
const nonDemoProjectId = `test-demo-seed-project-${runId}`;
const nonDemoInvoiceId = `test-demo-seed-invoice-${runId}`;
const nonDemoSnapshotId = `test-demo-seed-snapshot-${runId}`;
let databaseSuiteLockClient: DatabaseSuiteLockClient | undefined;

before(async () => {
  databaseSuiteLockClient = await acquirePersistenceDatabaseSuiteLock();
});

after(async () => {
  try {
    await db.delete(taxCalculationSnapshotsTable)
      .where(eq(taxCalculationSnapshotsTable.id, nonDemoSnapshotId));
    await db.delete(invoicesTable).where(eq(invoicesTable.id, nonDemoInvoiceId));
    await db.delete(projectsTable).where(eq(projectsTable.id, nonDemoProjectId));
  } finally {
    if (databaseSuiteLockClient) {
      await releasePersistenceDatabaseSuiteLock(databaseSuiteLockClient);
    }
  }
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
    .set({ taxRuleVersionId: null })
    .where(inArray(invoicesTable.id, demoIds));
  await db.update(taxCalculationSnapshotsTable)
    .set({ taxRuleVersionId: null })
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
});
