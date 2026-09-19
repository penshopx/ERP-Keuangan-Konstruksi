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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("petty_cash_policy_valid_period", sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`),
    check("petty_cash_policy_evidence_due_days_positive", sql`${table.evidenceDueDays} > 0`),
  ],
);

export const pettyCashRequestsTable = pgTable(
  "petty_cash_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "restrict" }),
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
      sql`${table.status} IN ('DIAJUKAN', 'DISETUJUI', 'DITOLAK', 'DICAIRKAN', 'DIPERTANGGUNGJAWABKAN', 'DIREKONSILIASI')`,
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
    receiptReference: text("receipt_reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("petty_cash_expenses_request_idx").on(table.requestId),
    check("petty_cash_expenses_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const insertPettyCashPolicyVersionSchema = createInsertSchema(pettyCashPolicyVersionsTable).omit({ createdAt: true });
export const insertPettyCashRequestSchema = createInsertSchema(pettyCashRequestsTable).omit({ createdAt: true, updatedAt: true });
export const insertPettyCashExpenseSchema = createInsertSchema(pettyCashExpensesTable).omit({ createdAt: true });
export type PettyCashPolicyVersion = typeof pettyCashPolicyVersionsTable.$inferSelect;
export type PettyCashRequest = typeof pettyCashRequestsTable.$inferSelect;
export type PettyCashExpense = typeof pettyCashExpensesTable.$inferSelect;
export type InsertPettyCashPolicyVersion = z.infer<typeof insertPettyCashPolicyVersionSchema>;
export type InsertPettyCashRequest = z.infer<typeof insertPettyCashRequestSchema>;
export type InsertPettyCashExpense = z.infer<typeof insertPettyCashExpenseSchema>;