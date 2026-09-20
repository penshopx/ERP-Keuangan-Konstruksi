import { jsonb, bigint, date, pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const budgetAlertThresholdsTable = pgTable("budget_alert_thresholds", {
  id: text("id").primaryKey(),
  alertType: text("alert_type").notNull(),
  thresholdPercent: bigint("threshold_percent", { mode: "number" }).notNull(),
  effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
  effectiveTo: date("effective_to", { mode: "string" }),
  owner: text("owner").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("budget_alert_thresholds_effective_idx").on(table.alertType, table.effectiveFrom)]);

export const budgetAlertsTable = pgTable("budget_alerts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  baselineId: text("baseline_id"),
  alertType: text("alert_type").notNull(),
  severity: text("severity").notNull(),
  owner: text("owner").notNull(),
  status: text("status").notNull().default("OPEN"),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedBy: text("acknowledged_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: text("resolved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("budget_alert_active_dedupe_idx").on(table.projectId, table.baselineId, table.alertType)
    .where(sql`${table.status} IN ('OPEN', 'ACKNOWLEDGED')`),
]);

export const insertBudgetAlertThresholdSchema = createInsertSchema(budgetAlertThresholdsTable);
export type BudgetAlertThreshold = typeof budgetAlertThresholdsTable.$inferSelect;
export type BudgetAlert = typeof budgetAlertsTable.$inferSelect;
export type InsertBudgetAlertThreshold = z.infer<typeof insertBudgetAlertThresholdSchema>;