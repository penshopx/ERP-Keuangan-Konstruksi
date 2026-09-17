import { sql } from "drizzle-orm";
import { bigint, check, date, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    owner: text("owner").notNull(),
    contractValue: bigint("contract_value", { mode: "number" }).notNull(),
    budget: bigint("budget", { mode: "number" }).notNull().default(0),
    actualCost: bigint("actual_cost", { mode: "number" }).notNull().default(0),
    progress: integer("progress").notNull().default(0),
    status: text("status").notNull().default("PERSIAPAN"),
    health: text("health").notNull().default("SEHAT"),
    endDate: date("end_date", { mode: "string" }).notNull(),
    wbsCount: integer("wbs_count").notNull().default(0),
    spiBasisPoints: integer("spi_basis_points").notNull().default(104),
    cpiBasisPoints: integer("cpi_basis_points").notNull().default(108),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "projects_status_supported",
      sql`${table.status} IN ('PERSIAPAN', 'BERJALAN', 'SELESAI')`,
    ),
  ],
);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;