import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const auditLogsTable = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  detail: text("detail").notNull(),
  user: text("user").notNull(),
  actorUserId: text("actor_user_id"),
  actorRole: text("actor_role"),
  tone: text("tone").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_logs_timestamp_idx").on(table.timestamp),
]);

export const insertAuditLogSchema = createInsertSchema(auditLogsTable);
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;