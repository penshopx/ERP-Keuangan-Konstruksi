import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const pettyCashPolicyVersionsTable = pgTable(
  "petty_cash_policy_versions",
  {
    id: text("id").primaryKey(),
    version: text("version").notNull().unique(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    sourceNote: text("source_note").notNull(),
    evidenceDueDays: integer("evidence_due_days").notNull(),
    maxRequestAmount: bigint("max_request_amount", { mode: "number" }).notNull().default(5000000),
    directorApprovalAbove: bigint("director_approval_above", { mode: "number" }).notNull().default(1000000),
    standardApproverRole: text("standard_approver_role").notNull().default("PROJECT_MANAGER"),
    highApproverRole: text("high_approver_role").notNull().default("DIRECTOR"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("petty_cash_policy_valid_period", sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`),
    check("petty_cash_policy_evidence_due_days_positive", sql`${table.evidenceDueDays} > 0`),
    check("petty_cash_policy_thresholds_valid", sql`${table.maxRequestAmount} > 0 AND ${table.directorApprovalAbove} >= 0 AND ${table.directorApprovalAbove} <= ${table.maxRequestAmount}`),
    check("petty_cash_policy_roles_valid", sql`${table.standardApproverRole} IN ('PROJECT_MANAGER','FINANCE','DIRECTOR') AND ${table.highApproverRole} IN ('PROJECT_MANAGER','FINANCE','DIRECTOR')`),
  ],
);

export const pettyCashFundsTable = pgTable("petty_cash_funds", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "restrict" }),
  location: text("location").notNull(),
  custodianUserId: text("custodian_user_id").notNull(),
  custodianName: text("custodian_name").notNull(),
  bookBalance: bigint("book_balance", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("petty_cash_funds_project_location_idx").on(table.projectId, table.location),
  check("petty_cash_funds_balance_nonnegative", sql`${table.bookBalance} >= 0`),
]);

export const pettyCashFundEventsTable = pgTable("petty_cash_fund_events", {
  id: text("id").primaryKey(),
  fundId: text("fund_id").notNull().references(() => pettyCashFundsTable.id, { onDelete: "restrict" }),
  requestId: text("request_id"),
  kind: text("kind").notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  reference: text("reference").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("petty_cash_fund_event_amount_positive", sql`${table.amount} > 0`),
]);

export const pettyCashRequestsTable = pgTable(
  "petty_cash_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "restrict" }),
    fundId: text("fund_id").references(() => pettyCashFundsTable.id, { onDelete: "restrict" }),
    projectCode: text("project_code").notNull(),
    projectName: text("project_name").notNull(),
    requesterUserId: text("requester_user_id").notNull(),
    requesterName: text("requester_name").notNull(),
    purpose: text("purpose").notNull(),
    costCode: text("cost_code").notNull(),
    requestedAmount: bigint("requested_amount", { mode: "number" }).notNull(),
    approvedAmount: bigint("approved_amount", { mode: "number" }),
    disbursedAmount: bigint("disbursed_amount", { mode: "number" }),
    spentAmount: bigint("spent_amount", { mode: "number" }),
    returnedAmount: bigint("returned_amount", { mode: "number" }),
    physicalCashAmount: bigint("physical_cash_amount", { mode: "number" }),
    status: text("status").notNull().default("DIAJUKAN"),
    requestedAt: date("requested_at", { mode: "string" }).notNull(),
    evidenceDueAt: date("evidence_due_at", { mode: "string" }).notNull(),
    policyVersionId: text("policy_version_id").notNull().references(() => pettyCashPolicyVersionsTable.id, { onDelete: "restrict" }),
    policyVersion: text("policy_version").notNull(),
    approverUserId: text("approver_user_id"),
    approverName: text("approver_name"),
    approvalNote: text("approval_note"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    disburserUserId: text("disburser_user_id"),
    disburserName: text("disburser_name"),
    disbursementReference: text("disbursement_reference"),
    disbursedAt: timestamp("disbursed_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    verifierUserId: text("verifier_user_id"),
    verifierName: text("verifier_name"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    evaluatorUserId: text("evaluator_user_id"),
    evaluatorName: text("evaluator_name"),
    evaluationNote: text("evaluation_note"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
    reconcilerUserId: text("reconciler_user_id"),
    reconcilerName: text("reconciler_name"),
    reconciliationNote: text("reconciliation_note"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index("petty_cash_requests_project_created_idx").on(table.projectId, table.createdAt),
    check("petty_cash_requests_amount_positive", sql`${table.requestedAmount} > 0`),
    check(
      "petty_cash_requests_status_supported",
      sql`${table.status} IN ('DIAJUKAN', 'DISETUJUI', 'DITOLAK', 'DICAIRKAN', 'DIPERTANGGUNGJAWABKAN', 'DIVERIFIKASI', 'DIREKONSILIASI', 'DIEVALUASI')`,
    ),
  ],
);

export const pettyCashExpensesTable = pgTable(
  "petty_cash_expenses",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull().references(() => pettyCashRequestsTable.id, { onDelete: "cascade" }),
    expenseDate: date("expense_date", { mode: "string" }).notNull(),
    description: text("description").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    receiptReference: text("receipt_reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("petty_cash_expenses_request_idx").on(table.requestId),
    check("petty_cash_expenses_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const pettyCashExceptionsTable = pgTable("petty_cash_exceptions", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().references(() => pettyCashRequestsTable.id, { onDelete: "cascade" }),
  expenseId: text("expense_id").notNull().references(() => pettyCashExpensesTable.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id").notNull(),
  dueAt: date("due_at", { mode: "string" }).notNull(),
  status: text("status").notNull().default("OPEN"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: text("resolved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPettyCashPolicyVersionSchema = createInsertSchema(pettyCashPolicyVersionsTable).omit({ createdAt: true });
export const insertPettyCashRequestSchema = createInsertSchema(pettyCashRequestsTable).omit({ createdAt: true, updatedAt: true });
export const insertPettyCashExpenseSchema = createInsertSchema(pettyCashExpensesTable).omit({ createdAt: true });
export type PettyCashPolicyVersion = typeof pettyCashPolicyVersionsTable.$inferSelect;
export type PettyCashRequest = typeof pettyCashRequestsTable.$inferSelect;
export type PettyCashExpense = typeof pettyCashExpensesTable.$inferSelect;
export type PettyCashFund = typeof pettyCashFundsTable.$inferSelect;
export type InsertPettyCashPolicyVersion = z.infer<typeof insertPettyCashPolicyVersionSchema>;
export type InsertPettyCashRequest = z.infer<typeof insertPettyCashRequestSchema>;
export type InsertPettyCashExpense = z.infer<typeof insertPettyCashExpenseSchema>;