import { bigint, date, integer, jsonb, pgTable, text, timestamp, uniqueIndex, check, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";
import { projectCostCodesTable } from "./procurement";
import { rabBaselinesTable, rabItemsTable } from "./rab";

export const materialsTable = pgTable("materials", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  baseUnit: text("base_unit").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("materials_code_idx").on(table.code)]);

export const rabMaterialRequirementsTable = pgTable("rab_material_requirements", {
  id: text("id").primaryKey(),
  baselineId: text("baseline_id").notNull().references(() => rabBaselinesTable.id, { onDelete: "cascade" }),
  rabItemId: text("rab_item_id").notNull().references(() => rabItemsTable.id, { onDelete: "cascade" }),
  costCodeId: text("cost_code_id").notNull().references(() => projectCostCodesTable.id, { onDelete: "restrict" }),
  materialId: text("material_id").notNull().references(() => materialsTable.id, { onDelete: "restrict" }),
  analysisVersion: integer("analysis_version").notNull(),
  coefficientMicros: bigint("coefficient_micros", { mode: "number" }).notNull(),
  unit: text("unit").notNull(),
  effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
  effectiveTo: date("effective_to", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("rab_material_requirement_version_idx").on(table.baselineId, table.rabItemId, table.materialId, table.analysisVersion),
  check("rab_material_requirement_coefficient_positive", sql`${table.coefficientMicros} > 0`),
]);

export const materialWasteToleranceVersionsTable = pgTable("material_waste_tolerance_versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projectsTable.id, { onDelete: "cascade" }),
  costCodeId: text("cost_code_id").references(() => projectCostCodesTable.id, { onDelete: "cascade" }),
  materialId: text("material_id").references(() => materialsTable.id, { onDelete: "cascade" }),
  workCategory: text("work_category"),
  toleranceBasisPoints: integer("tolerance_basis_points").notNull(),
  effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
  effectiveTo: date("effective_to", { mode: "string" }),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("material_waste_tolerance_lookup_idx").on(table.projectId, table.costCodeId, table.materialId, table.effectiveFrom),
  check("material_waste_tolerance_range", sql`${table.toleranceBasisPoints} BETWEEN 0 AND 10000`),
  check("material_waste_tolerance_period", sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`),
]);

export const inventoryMovementsTable = pgTable("inventory_movements", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  baselineId: text("baseline_id").notNull().references(() => rabBaselinesTable.id, { onDelete: "restrict" }),
  costCodeId: text("cost_code_id").notNull().references(() => projectCostCodesTable.id, { onDelete: "restrict" }),
  materialId: text("material_id").notNull().references(() => materialsTable.id, { onDelete: "restrict" }),
  movementType: text("movement_type").notNull(),
  quantityMicros: bigint("quantity_micros", { mode: "number" }).notNull(),
  unit: text("unit").notNull(),
  baseQuantityMicros: bigint("base_quantity_micros", { mode: "number" }).notNull(),
  sourceDocumentType: text("source_document_type").notNull(),
  sourceDocumentId: text("source_document_id").notNull(),
  sourceDocumentNumber: text("source_document_number").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  notes: text("notes"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("inventory_movement_source_idx").on(table.sourceDocumentType, table.sourceDocumentId, table.movementType, table.materialId, table.costCodeId),
  index("inventory_movement_reconciliation_idx").on(table.projectId, table.baselineId, table.costCodeId, table.materialId),
  check("inventory_movement_type_supported", sql`${table.movementType} IN ('PROCURED', 'RECEIVED', 'ISSUED', 'RETURNED', 'INSTALLED', 'INVOICED', 'ACTUAL_COST', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT')`),
  check("inventory_movement_quantity_nonnegative", sql`${table.quantityMicros} >= 0 AND ${table.baseQuantityMicros} >= 0`),
]);

export const materialVarianceExceptionsTable = pgTable("material_variance_exceptions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  baselineId: text("baseline_id").notNull().references(() => rabBaselinesTable.id, { onDelete: "restrict" }),
  costCodeId: text("cost_code_id").notNull().references(() => projectCostCodesTable.id, { onDelete: "restrict" }),
  rabItemId: text("rab_item_id").notNull().references(() => rabItemsTable.id, { onDelete: "restrict" }),
  materialId: text("material_id").notNull().references(() => materialsTable.id, { onDelete: "restrict" }),
  toleranceVersionId: text("tolerance_version_id").references(() => materialWasteToleranceVersionsTable.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("OPEN"),
  classification: text("classification"),
  disposition: text("disposition"),
  theoreticalQuantityMicros: bigint("theoretical_quantity_micros", { mode: "number" }).notNull(),
  consumedQuantityMicros: bigint("consumed_quantity_micros", { mode: "number" }).notNull(),
  varianceQuantityMicros: bigint("variance_quantity_micros", { mode: "number" }).notNull(),
  toleranceQuantityMicros: bigint("tolerance_quantity_micros", { mode: "number" }).notNull(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  closedBy: text("closed_by"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("material_variance_exception_open_idx").on(table.projectId, table.baselineId, table.costCodeId, table.materialId),
  check("material_variance_exception_status_supported", sql`${table.status} IN ('OPEN', 'UNDER_REVIEW', 'CLOSED')`),
  check("material_variance_exception_classification_supported", sql`${table.classification} IS NULL OR ${table.classification} IN ('WASTE', 'DESIGN_CHANGE', 'REWORK', 'MISALLOCATION', 'RECORDING_DELAY', 'IN_TRANSIT', 'UNIT_CONVERSION', 'DAMAGE', 'LOSS')`),
]);

export const materialVarianceEventsTable = pgTable("material_variance_events", {
  id: text("id").primaryKey(),
  exceptionId: text("exception_id").notNull().references(() => materialVarianceExceptionsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  actorName: text("actor_name").notNull(),
  detail: text("detail").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertInventoryMovementSchema = createInsertSchema(inventoryMovementsTable).omit({ createdAt: true });
export type InsertInventoryMovement = z.infer<typeof insertInventoryMovementSchema>;
export type InventoryMovement = typeof inventoryMovementsTable.$inferSelect;
export type MaterialVarianceException = typeof materialVarianceExceptionsTable.$inferSelect;