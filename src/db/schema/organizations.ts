import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(), // used in AP inbox routing addresses (§3.2)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
