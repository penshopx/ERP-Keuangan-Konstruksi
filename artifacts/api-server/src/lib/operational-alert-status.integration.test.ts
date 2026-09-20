import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  operationalAlertDeliveryStatusTable,
} from "@workspace/db";
import {
  listOperationalAlertDeliveryStatuses,
  recordOperationalAlertDeliveryStatus,
} from "./operational-alert-status";

test("stores only the newest delivery result for each alert source", async () => {
  const source = `test-operational-alert-${Date.now()}`;
  try {
    await recordOperationalAlertDeliveryStatus({
      source,
      attemptedAt: new Date("2026-09-20T10:00:00.000Z"),
      result: "DELIVERY_FAILED",
    });
    await recordOperationalAlertDeliveryStatus({
      source,
      attemptedAt: new Date("2026-09-20T09:00:00.000Z"),
      result: "DELIVERED",
    });

    const statuses = await listOperationalAlertDeliveryStatuses();
    const status = statuses.find((item) => item.source === source);
    assert.deepEqual(status, {
      source,
      lastAttemptAt: "2026-09-20T10:00:00.000Z",
      lastResult: "DELIVERY_FAILED",
    });
    assert.equal(JSON.stringify(status).includes("webhook"), false);
  } finally {
    await db.delete(operationalAlertDeliveryStatusTable).where(
      eq(operationalAlertDeliveryStatusTable.source, source),
    );
  }
});