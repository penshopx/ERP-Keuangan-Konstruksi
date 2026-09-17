import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const operationalStateTable = pgTable("operational_state", {
  key: text("key").primaryKey(),
  lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});