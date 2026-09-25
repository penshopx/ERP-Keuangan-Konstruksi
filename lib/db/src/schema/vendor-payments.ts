import { bigint, integer, jsonb, pgTable, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { commitmentLinesTable, commitmentTable, projectCostCodesTable } from "./procurement";
import { projectsTable } from "./projects";

export const vendorMatchPoliciesTable = pgTable("vendor_match_policies", {
  id: text("id").primaryKey(),
  version: integer("version").notNull().unique(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  quantityToleranceBasisPoints: integer("quantity_tolerance_basis_points").notNull(),
  priceToleranceBasisPoints: integer("price_tolerance_basis_points").notNull(),
  taxTolerance: bigint("tax_tolerance", { mode: "number" }).notNull(),
  retentionTolerance: bigint("retention_tolerance", { mode: "number" }).notNull(),
  totalTolerance: bigint("total_tolerance", { mode: "number" }).notNull(),
}, (t) => [
  check("vendor_match_policy_valid", sql`${t.quantityToleranceBasisPoints} BETWEEN 0 AND 10000 AND ${t.priceToleranceBasisPoints} BETWEEN 0 AND 10000 AND ${t.taxTolerance} >= 0 AND ${t.retentionTolerance} >= 0 AND ${t.totalTolerance} >= 0`),
]);

export const vendorInvoicesTable = pgTable("vendor_invoices", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "restrict" }),
  commitmentId: text("commitment_id").notNull().references(() => commitmentTable.id, { onDelete: "restrict" }),
  lineId: text("line_id").notNull().references(() => commitmentLinesTable.id, { onDelete: "restrict" }),
  costCodeId: text("cost_code_id").notNull().references(() => projectCostCodesTable.id, { onDelete: "restrict" }),
  vendorKey: text("vendor_key").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  kind: text("kind").notNull().default("INVOICE"),
  originalInvoiceId: text("original_invoice_id"),
  quantity: integer("quantity").notNull(),
  unitPrice: bigint("unit_price", { mode: "number" }).notNull(),
  tax: bigint("tax", { mode: "number" }).notNull(),
  retention: bigint("retention", { mode: "number" }).notNull(),
  total: bigint("total", { mode: "number" }).notNull(),
  receiptEventIds: jsonb("receipt_event_ids").$type<string[]>().notNull(),
  evidence: text("evidence").notNull(),
  status: text("status").notNull().default("EXCEPTION"),
  exceptions: jsonb("exceptions").$type<string[]>().notNull().default([]),
  policyVersion: integer("policy_version").notNull(),
  policySnapshot: jsonb("policy_snapshot").$type<Record<string, number>>().notNull(),
  eligibleAmount: bigint("eligible_amount", { mode: "number" }).notNull().default(0),
  makerId: text("maker_id").notNull(),
  reviewerId: text("reviewer_id"),
  reviewEvidence: text("review_evidence"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("vendor_invoice_number_unique").on(t.vendorKey, t.invoiceNumber),
  check("vendor_invoice_values_valid", sql`${t.quantity} > 0 AND ${t.unitPrice} >= 0 AND ${t.tax} >= 0 AND ${t.retention} >= 0 AND ${t.total} >= 0`),
]);

export const vendorPaymentsTable = pgTable("vendor_payments", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull().references(() => vendorInvoicesTable.id, { onDelete: "restrict" }),
  amount: bigint("amount", { mode: "number" }).notNull(),
  status: text("status").notNull().default("REQUESTED"),
  makerId: text("maker_id").notNull(),
  approverId: text("approver_id"),
  releaserId: text("releaser_id"),
  evidence: text("evidence").notNull(),
  approvalEvidence: text("approval_evidence"),
  releaseEvidence: text("release_evidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("vendor_payment_positive", sql`${t.amount} > 0`)]);