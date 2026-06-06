import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(), // resolves AP inbox routing (§3.2)
  externalAccountingSystem: text("external_accounting_system"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
