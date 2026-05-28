import { pgTable, uuid, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { clients } from "./clients";
import { userRole } from "./enums";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  name: text("name"),
  role: userRole("role").notNull().default("reviewer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * (user, client) scope for firms with multiple clients (addendum §1.5).
 * Effective permission = max(users.role, user_client_access.role for client).
 */
export const userClientAccess = pgTable(
  "user_client_access",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    role: userRole("role").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.clientId] }) }),
);
