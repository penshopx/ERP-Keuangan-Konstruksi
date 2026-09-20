import { bigint, date, integer, jsonb, pgTable, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";
import { rabBaselinesTable } from "./rab";

export const competencyCatalogTable = pgTable("competency_catalog", {
  id: text("id").primaryKey(),
  schemeCode: text("scheme_code").notNull(),
  schemeType: text("scheme_type").notNull(),
  occupation: text("occupation").notNull(),
  title: text("title").notNull(),
  level: integer("level").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceNote: text("source_note").notNull().default("Referensi pengguna; validitas hukum harus diverifikasi terhadap Kemnaker."),
  validityStatus: text("validity_status").notNull().default("REFERENCE_ONLY"),
  effectiveFrom: date("effective_from", { mode: "string" }),
  effectiveTo: date("effective_to", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("competency_catalog_entry_idx").on(table.schemeCode, table.title, table.level),
  check("competency_catalog_level_range", sql`${table.level} BETWEEN 1 AND 9`),
]);

export const userCompetencyProfilesTable = pgTable("user_competency_profiles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  catalogEntryId: text("catalog_entry_id").notNull().references(() => competencyCatalogTable.id, { onDelete: "restrict" }),
  verificationStatus: text("verification_status").notNull().default("UNVERIFIED"),
  certificateReference: text("certificate_reference"),
  effectiveFrom: date("effective_from", { mode: "string" }),
  expiresAt: date("expires_at", { mode: "string" }),
  verifiedBy: text("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [uniqueIndex("user_competency_profile_entry_idx").on(table.userId, table.catalogEntryId)]);

export const ahsTemplatesTable = pgTable("ahs_templates", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  unit: text("unit").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull().default("DRAFT"),
  sourceNote: text("source_note").notNull(),
  effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
  effectiveTo: date("effective_to", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("ahs_template_code_version_idx").on(table.code, table.version)]);

export const ahsComponentsTable = pgTable("ahs_components", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull().references(() => ahsTemplatesTable.id, { onDelete: "cascade" }),
  resourceKind: text("resource_kind").notNull(),
  resourceCode: text("resource_code").notNull(),
  resourceName: text("resource_name").notNull(),
  unit: text("unit").notNull(),
  coefficientMicros: bigint("coefficient_micros", { mode: "number" }).notNull(),
  wasteBasisPoints: integer("waste_basis_points").notNull().default(0),
}, (table) => [check("ahs_component_kind", sql`${table.resourceKind} IN ('MATERIAL','LABOR','EQUIPMENT')`), check("ahs_component_coefficient_positive", sql`${table.coefficientMicros} > 0`)]);

export const resourcePricesTable = pgTable("resource_prices", {
  id: text("id").primaryKey(),
  resourceKind: text("resource_kind").notNull(),
  resourceCode: text("resource_code").notNull(),
  unit: text("unit").notNull(),
  unitPriceRupiah: bigint("unit_price_rupiah", { mode: "number" }).notNull(),
  effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
  effectiveTo: date("effective_to", { mode: "string" }),
  sourceNote: text("source_note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("resource_price_period_idx").on(table.resourceKind, table.resourceCode, table.effectiveFrom), check("resource_price_nonnegative", sql`${table.unitPriceRupiah} >= 0`)]);

export const estimatePreviewsTable = pgTable("estimate_previews", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  templateId: text("template_id").notNull().references(() => ahsTemplatesTable.id, { onDelete: "restrict" }),
  effectiveDate: date("effective_date", { mode: "string" }).notNull(),
  volumeBasisPoints: integer("volume_basis_points").notNull(),
  unitPriceRupiah: bigint("unit_price_rupiah", { mode: "number" }).notNull(),
  totalBudgetRupiah: bigint("total_budget_rupiah", { mode: "number" }).notNull(),
  formulaSnapshot: jsonb("formula_snapshot").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("PREVIEW"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rabEstimateSnapshotsTable = pgTable("rab_estimate_snapshots", {
  id: text("id").primaryKey(),
  baselineId: text("baseline_id").notNull().references(() => rabBaselinesTable.id, { onDelete: "cascade" }),
  previewId: text("preview_id").notNull().references(() => estimatePreviewsTable.id, { onDelete: "restrict" }),
  formulaSnapshot: jsonb("formula_snapshot").$type<Record<string, unknown>>().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCompetencyProfileSchema = createInsertSchema(userCompetencyProfilesTable).omit({ createdAt: true, updatedAt: true });
export type CompetencyCatalogEntry = typeof competencyCatalogTable.$inferSelect;
export type UserCompetencyProfile = typeof userCompetencyProfilesTable.$inferSelect;
export type AhsTemplate = typeof ahsTemplatesTable.$inferSelect;
export type AhsComponent = typeof ahsComponentsTable.$inferSelect;
export type ResourcePrice = typeof resourcePricesTable.$inferSelect;
export type EstimatePreview = typeof estimatePreviewsTable.$inferSelect;
export type InsertCompetencyProfile = z.infer<typeof insertCompetencyProfileSchema>;