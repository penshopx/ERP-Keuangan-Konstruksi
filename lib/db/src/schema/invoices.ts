import { bigint, boolean, date, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const invoicesTable = pgTable("invoices", {
  id: text("id").primaryKey(),
  sequence: serial("sequence").notNull(),
  number: text("number").notNull().unique(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "restrict" }),
  projectCode: text("project_code").notNull(),
  projectName: text("project_name").notNull(),
  period: text("period").notNull(),
  dpp: bigint("dpp", { mode: "number" }).notNull(),
  ppn: bigint("ppn", { mode: "number" }).notNull(),
  pphFinal: bigint("pph_final", { mode: "number" }).notNull(),
  retention: bigint("retention", { mode: "number" }).notNull(),
  total: bigint("total", { mode: "number" }).notNull(),
  status: text("status").notNull(),
  issuedAt: date("issued_at", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const taxCalculationSnapshotsTable = pgTable("tax_calculation_snapshots", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull().unique().references(() => invoicesTable.id, { onDelete: "cascade" }),
  dpp: bigint("dpp", { mode: "number" }).notNull(),
  integrated: boolean("integrated").notNull(),
  dppLainRateBasisPoints: integer("dpp_lain_rate_basis_points").notNull(),
  ppnRateBasisPoints: integer("ppn_rate_basis_points").notNull(),
  pphRateBasisPoints: integer("pph_rate_basis_points").notNull(),
  retentionPercentBasisPoints: integer("retention_percent_basis_points").notNull(),
  ppn: bigint("ppn", { mode: "number" }).notNull(),
  pphFinal: bigint("pph_final", { mode: "number" }).notNull(),
  retention: bigint("retention", { mode: "number" }).notNull(),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ createdAt: true, updatedAt: true });
export const insertTaxCalculationSnapshotSchema = createInsertSchema(taxCalculationSnapshotsTable).omit({ calculatedAt: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
export type InsertTaxCalculationSnapshot = z.infer<typeof insertTaxCalculationSnapshotSchema>;
export type TaxCalculationSnapshot = typeof taxCalculationSnapshotsTable.$inferSelect;