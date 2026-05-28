import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Append-only (addendum §4.1). Every mutation, approval, rejection, export,
 * and admin (BYPASSRLS) session lands here.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(), // 'user' | 'worker' | 'admin' | 'system'
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index("idx_audit_events_entity").on(t.entityType, t.entityId),
  }),
);
