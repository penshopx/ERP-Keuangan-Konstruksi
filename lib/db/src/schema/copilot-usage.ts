import { check, date, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const copilotLimitsTable = pgTable("copilot_limits", {
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull(),
  dailyLimit: integer("daily_limit").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // A scope has exactly one limit; updates cannot be made from the copilot runtime.
  check("copilot_limits_scope_valid", sql`${t.scope} IN ('role', 'project')`),
  check("copilot_limits_daily_limit_valid", sql`${t.dailyLimit} BETWEEN 0 AND 100000`),
  primaryKey({ columns: [t.scope, t.scopeId], name: "copilot_limits_pk" }),
]);

export const copilotUsageTable = pgTable("copilot_usage", {
  id: text("id").primaryKey(),
  day: date("day", { mode: "string" }).notNull(),
  role: text("role").notNull(),
  projectId: text("project_id"),
  tool: text("tool").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("copilot_usage_day_role_idx").on(t.day, t.role),
  index("copilot_usage_day_project_idx").on(t.day, t.projectId),
  check("copilot_usage_status_valid", sql`${t.status} IN ('RUNNING', 'SUCCESS', 'FAILED', 'TIMEOUT')`),
]);