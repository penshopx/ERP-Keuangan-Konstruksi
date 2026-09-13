import { bigint, boolean, date, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const taxRuleVersionsTable = pgTable("tax_rule_versions", {
  id: text("id").primaryKey(),
  version: text("version").notNull().unique(),
  effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
  effectiveTo: date("effective_to", { mode: "string" }),
  regulatorySource: text("regulatory_source").notNull(),
  serviceType: text("service_type").notNull(),
  qualification: text("qualification"),
  requiresSbu: boolean("requires_sbu").notNull(),
  supplierPkp: boolean("supplier_pkp").notNull(),
  governmentCollector: boolean("government_collector").notNull(),
  integrated: boolean("integrated").notNull(),
  dppRateBasisPoints: integer("dpp_rate_basis_points").notNull(),
  ppnRateBasisPoints: integer("ppn_rate_basis_points").notNull(),
  pphFinalRateBasisPoints: integer("pph_final_rate_basis_points").notNull(),
  pph23RateBasisPoints: integer("pph_23_rate_basis_points").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  pph23: bigint("pph_23", { mode: "number" }).notNull().default(0),
  retention: bigint("retention", { mode: "number" }).notNull(),
  total: bigint("total", { mode: "number" }).notNull(),
  status: text("status").notNull(),
  issuedAt: date("issued_at", { mode: "string" }).notNull(),
  taxRuleVersionId: text("tax_rule_version_id").references(() => taxRuleVersionsTable.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const taxCalculationSnapshotsTable = pgTable("tax_calculation_snapshots", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull().unique().references(() => invoicesTable.id, { onDelete: "cascade" }),
  taxRuleVersionId: text("tax_rule_version_id").references(() => taxRuleVersionsTable.id, { onDelete: "restrict" }),
  ruleVersion: text("rule_version").notNull().default("LEGACY"),
  regulatorySource: text("regulatory_source").notNull().default("Snapshot transaksi sebelum aturan berversi"),
  ruleSnapshot: jsonb("rule_snapshot").notNull().default({}),
  dpp: bigint("dpp", { mode: "number" }).notNull(),
  serviceType: text("service_type").notNull().default("KONSTRUKSI"),
  qualification: text("qualification").notNull().default("TANPA_KUALIFIKASI"),
  hasSbu: boolean("has_sbu").notNull().default(false),
  supplierPkp: boolean("supplier_pkp").notNull().default(true),
  governmentCollector: boolean("government_collector").notNull().default(false),
  integrated: boolean("integrated").notNull(),
  dppLainRateBasisPoints: integer("dpp_lain_rate_basis_points").notNull(),
  ppnRateBasisPoints: integer("ppn_rate_basis_points").notNull(),
  pphRateBasisPoints: integer("pph_rate_basis_points").notNull(),
  retentionPercentBasisPoints: integer("retention_percent_basis_points").notNull(),
  ppn: bigint("ppn", { mode: "number" }).notNull(),
  pphFinal: bigint("pph_final", { mode: "number" }).notNull(),
  pph23: bigint("pph_23", { mode: "number" }).notNull().default(0),
  retention: bigint("retention", { mode: "number" }).notNull(),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ createdAt: true, updatedAt: true });
export const insertTaxRuleVersionSchema = createInsertSchema(taxRuleVersionsTable).omit({ createdAt: true });
export const insertTaxCalculationSnapshotSchema = createInsertSchema(taxCalculationSnapshotsTable).omit({ calculatedAt: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
export type InsertTaxRuleVersion = z.infer<typeof insertTaxRuleVersionSchema>;
export type TaxRuleVersion = typeof taxRuleVersionsTable.$inferSelect;
export type InsertTaxCalculationSnapshot = z.infer<typeof insertTaxCalculationSnapshotSchema>;
export type TaxCalculationSnapshot = typeof taxCalculationSnapshotsTable.$inferSelect;