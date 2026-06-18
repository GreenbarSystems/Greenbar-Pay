import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * API-level idempotency keys (addendum §4.6).
 *
 * Composite PK on (organization_id, key) since PR2 — review #5 flagged
 * that the original single-column PK let org A squat / collide with
 * org B's keys (replay-denial). Per-org scoping makes that impossible.
 *
 * 24-hour TTL; a cron job prunes by created_at.
 */
export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(), // sha256(method+path+body)
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.key] }),
    createdIdx: index("idx_api_idempotency_keys_created").on(t.createdAt),
  }),
);
