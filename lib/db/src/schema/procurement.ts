import { bigint, integer, pgTable, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";
import { rabBaselinesTable, rabItemsTable } from "./rab";

export const projectCostCodesTable = pgTable("project_cost_codes", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("project_cost_codes_project_code_idx").on(table.projectId, table.code)]);

export const commitmentTable = pgTable("commitments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  baselineId: text("baseline_id").notNull().references(() => rabBaselinesTable.id, { onDelete: "restrict" }),
  documentType: text("document_type").notNull(),
  documentNumber: text("document_number").notNull(),
  vendorName: text("vendor_name").notNull(),
  status: text("status").notNull().default("DRAFT"),
  version: integer("version").notNull().default(1),
  totalAmount: bigint("total_amount", { mode: "number" }).notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("commitments_project_document_idx").on(table.projectId, table.documentNumber, table.version),
  check("commitments_document_type_supported", sql`${table.documentType} IN ('PO', 'SPK', 'SUBKON')`),
  check("commitments_status_supported", sql`${table.status} IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED')`),
  check("commitments_total_nonnegative", sql`${table.totalAmount} >= 0`),
]);

export const commitmentLinesTable = pgTable("commitment_lines", {
  id: text("id").primaryKey(),
  commitmentId: text("commitment_id").notNull().references(() => commitmentTable.id, { onDelete: "cascade" }),
  costCodeId: text("cost_code_id").notNull().references(() => projectCostCodesTable.id, { onDelete: "restrict" }),
  rabItemId: text("rab_item_id").references(() => rabItemsTable.id, { onDelete: "restrict" }),
  description: text("description").notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  receivedAmount: bigint("received_amount", { mode: "number" }).notNull().default(0),
  invoicedAmount: bigint("invoiced_amount", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check("commitment_lines_amount_nonnegative", sql`${table.amount} >= 0`)]);

export const commitmentEventsTable = pgTable("commitment_events", {
  id: text("id").primaryKey(),
  commitmentId: text("commitment_id").notNull().references(() => commitmentTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  amount: bigint("amount", { mode: "number" }).notNull().default(0),
  metadata: text("metadata").notNull().default("{}"),
  actorUserId: text("actor_user_id").notNull(),
  sourceId: text("source_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("commitment_events_source_idx").on(table.commitmentId, table.eventType, table.sourceId)]);

export const actualCostAllocationsTable = pgTable("actual_cost_allocations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  baselineId: text("baseline_id").notNull().references(() => rabBaselinesTable.id, { onDelete: "restrict" }),
  costCodeId: text("cost_code_id").notNull().references(() => projectCostCodesTable.id, { onDelete: "restrict" }),
  commitmentId: text("commitment_id").references(() => commitmentTable.id, { onDelete: "restrict" }),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("actual_cost_allocations_source_idx").on(table.sourceType, table.sourceId, table.costCodeId),
  check("actual_cost_allocations_amount_nonnegative", sql`${table.amount} >= 0`),
]);

export const insertProjectCostCodeSchema = createInsertSchema(projectCostCodesTable).omit({ createdAt: true });
export type ProjectCostCode = typeof projectCostCodesTable.$inferSelect;
export type Commitment = typeof commitmentTable.$inferSelect;
export type CommitmentLine = typeof commitmentLinesTable.$inferSelect;
export type CommitmentEvent = typeof commitmentEventsTable.$inferSelect;
export type ActualCostAllocation = typeof actualCostAllocationsTable.$inferSelect;
export type InsertProjectCostCode = z.infer<typeof insertProjectCostCodeSchema>;