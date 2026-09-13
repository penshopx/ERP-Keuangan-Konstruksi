import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type RabTemplateItemData = {
  code: string;
  parentCode?: string | null;
  level: number;
  name: string;
  category: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  materialCost: number;
  laborCost: number;
  equipmentCost: number;
};

export const rabTemplatesTable = pgTable("rab_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  projectType: text("project_type").notNull(),
  description: text("description").notNull(),
  sourceNote: text("source_note").notNull(),
  items: jsonb("items").$type<RabTemplateItemData[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRabTemplateSchema = createInsertSchema(rabTemplatesTable).omit({ createdAt: true, updatedAt: true });
export type InsertRabTemplate = z.infer<typeof insertRabTemplateSchema>;
export type RabTemplate = typeof rabTemplatesTable.$inferSelect;