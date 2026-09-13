import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const userRolesTable = pgTable("user_roles", {
  userId: text("user_id").primaryKey(),
  role: text("role").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const projectAssignmentsTable = pgTable("project_assignments", {
  userId: text("user_id").notNull().references(() => userRolesTable.userId, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.projectId] })]);