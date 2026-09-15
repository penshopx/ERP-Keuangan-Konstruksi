import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appMigrations = pgTable("app_migrations", {
  name: text("name").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});