import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * API-level idempotency keys (addendum §4.6). 24-hour TTL; a cron job prunes.
 */
export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    key: text("key").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestHash: text("request_hash").notNull(), // sha256(method+path+body)
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index("idx_api_idempotency_keys_created").on(t.createdAt),
  }),
);
