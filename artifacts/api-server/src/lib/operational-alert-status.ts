import { asc, sql } from "drizzle-orm";
import {
  db,
  operationalAlertDeliveryStatusTable,
} from "@workspace/db";
import type {
  OperationalAlertDeliveryStatus,
} from "@workspace/db/operational-alert";

export async function recordOperationalAlertDeliveryStatus(
  status: OperationalAlertDeliveryStatus,
): Promise<void> {
  await db.insert(operationalAlertDeliveryStatusTable).values({
    source: status.source,
    lastAttemptAt: status.attemptedAt,
    lastResult: status.result,
  }).onConflictDoUpdate({
    target: operationalAlertDeliveryStatusTable.source,
    set: {
      lastAttemptAt: sql`excluded.last_attempt_at`,
      lastResult: sql`excluded.last_result`,
      updatedAt: sql`now()`,
    },
    setWhere: sql`
      ${operationalAlertDeliveryStatusTable.lastAttemptAt}
        <= excluded.last_attempt_at
    `,
  });
}

export async function listOperationalAlertDeliveryStatuses() {
  const statuses = await db.select({
    source: operationalAlertDeliveryStatusTable.source,
    lastAttemptAt: operationalAlertDeliveryStatusTable.lastAttemptAt,
    lastResult: operationalAlertDeliveryStatusTable.lastResult,
  }).from(operationalAlertDeliveryStatusTable)
    .orderBy(asc(operationalAlertDeliveryStatusTable.source));

  return statuses.map((status) => ({
    ...status,
    lastAttemptAt: status.lastAttemptAt.toISOString(),
  }));
}