import { bigint, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const rabBaselinesTable = pgTable("rab_baselines", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [uniqueIndex("rab_baselines_project_version_idx").on(table.projectId, table.version)]);

export const rabItemsTable = pgTable("rab_items", {
  id: text("id").primaryKey(),
  baselineId: text("baseline_id").notNull().references(() => rabBaselinesTable.id, { onDelete: "cascade" }),
  costCodeId: text("cost_code_id"),
  code: text("code").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  parentCode: text("parent_code"),
  level: integer("level").notNull().default(1),
  unit: text("unit").notNull().default("ls"),
  quantityBasisPoints: bigint("quantity_basis_points", { mode: "number" }).notNull().default(100),
  unitPrice: bigint("unit_price", { mode: "number" }).notNull().default(0),
  materialCost: bigint("material_cost", { mode: "number" }).notNull().default(0),
  laborCost: bigint("labor_cost", { mode: "number" }).notNull().default(0),
  equipmentCost: bigint("equipment_cost", { mode: "number" }).notNull().default(0),
  budget: bigint("budget", { mode: "number" }).notNull(),
  committed: bigint("committed", { mode: "number" }).notNull(),
  actual: bigint("actual", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRabBaselineSchema = createInsertSchema(rabBaselinesTable).omit({ createdAt: true, updatedAt: true });
export const insertRabItemSchema = createInsertSchema(rabItemsTable).omit({ createdAt: true, updatedAt: true });
export type InsertRabBaseline = z.infer<typeof insertRabBaselineSchema>;
export type RabBaseline = typeof rabBaselinesTable.$inferSelect;
export type InsertRabItem = z.infer<typeof insertRabItemSchema>;
export type RabItem = typeof rabItemsTable.$inferSelect;