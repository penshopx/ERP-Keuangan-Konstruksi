import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const accountsTable = pgTable("finance_accounts", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  cashFlow: text("cash_flow"),
  isCash: boolean("is_cash").notNull().default(false),
  active: text("active").notNull().default("YES"),
}, (t) => [
  check("finance_account_type", sql`${t.type} IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')`),
  check("finance_cash_flow", sql`${t.cashFlow} IS NULL OR ${t.cashFlow} IN ('OPERATING','INVESTING','FINANCING')`),
]);

export const financePeriodsTable = pgTable("finance_periods", {
  month: text("month").primaryKey(),
  status: text("status").notNull().default("OPEN"),
  checklist: jsonb("checklist").$type<Record<string, { done: boolean; note: string }>>().notNull().default({}),
  preparedBy: text("prepared_by"),
  approvedBy: text("approved_by"),
  reopenReason: text("reopen_reason"),
  reopenRequestedBy: text("reopen_requested_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("finance_period_status", sql`${t.status} IN ('OPEN','REVIEW','CLOSED','REOPENED')`)]);

export const journalEntriesTable = pgTable("journal_entries", {
  id: text("id").primaryKey(),
  period: text("period").notNull().references(() => financePeriodsTable.month),
  entryDate: date("entry_date", { mode: "string" }).notNull(),
  kind: text("kind").notNull().default("NORMAL"),
  cashFlowCategory: text("cash_flow_category"),
  description: text("description").notNull(),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  reversesId: text("reverses_id"),
  actorUserId: text("actor_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("journal_kind", sql`${t.kind} IN ('NORMAL','ADJUSTMENT','REVERSAL')`),
  check("journal_cash_flow_category", sql`${t.cashFlowCategory} IS NULL OR ${t.cashFlowCategory} IN ('OPERATING','INVESTING','FINANCING')`),
  uniqueIndex("journal_one_reversal").on(t.reversesId),
]);

export const journalLinesTable = pgTable("journal_lines", {
  id: text("id").primaryKey(),
  entryId: text("entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
  accountCode: text("account_code").notNull().references(() => accountsTable.code, { onDelete: "restrict" }),
  debit: bigint("debit", { mode: "number" }).notNull().default(0),
  credit: bigint("credit", { mode: "number" }).notNull().default(0),
  projectId: text("project_id").references(() => projectsTable.id, { onDelete: "restrict" }),
  wbs: text("wbs"),
  costCode: text("cost_code"),
}, (t) => [
  check("journal_positive_side", sql`(${t.debit} > 0 AND ${t.credit} = 0) OR (${t.credit} > 0 AND ${t.debit} = 0)`),
]);

export const financeReportVersionsTable = pgTable("finance_report_versions", {
  id: text("id").primaryKey(),
  period: text("period").notNull().references(() => financePeriodsTable.month),
  version: integer("version").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  approvedBy: text("approved_by").notNull(),
  report: jsonb("report").$type<Record<string, unknown>>().notNull(),
}, (t) => [uniqueIndex("finance_report_period_version").on(t.period, t.version)]);