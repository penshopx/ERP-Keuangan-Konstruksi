import { sql } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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

export const staffInvitationsTable = pgTable("staff_invitations", {
  id: text("id").primaryKey(),
  clerkInvitationId: text("clerk_invitation_id").notNull().unique(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  status: text("status").notNull().default("PENDING"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedUserId: text("accepted_user_id").references(() => userRolesTable.userId),
  invitedByUserId: text("invited_by_user_id").notNull().references(() => userRolesTable.userId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("staff_invitations_pending_email_idx")
    .on(table.email)
    .where(sql`${table.status} = 'PENDING'`),
]);

export const staffInvitationProjectsTable = pgTable("staff_invitation_projects", {
  invitationId: text("invitation_id").notNull().references(() => staffInvitationsTable.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.invitationId, table.projectId] })]);