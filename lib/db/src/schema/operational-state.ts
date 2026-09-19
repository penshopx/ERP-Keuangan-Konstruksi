import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const operationalStateTable = pgTable("operational_state", {
  key: text("key").primaryKey(),
  lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invitationReconciliationStateTable = pgTable(
  "invitation_reconciliation_state",
  {
    key: text("key").primaryKey(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRun: jsonb("last_run").$type<Record<string, unknown>>(),
    monitoringStartedAt: timestamp("monitoring_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);