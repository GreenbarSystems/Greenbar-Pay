import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Validation outcomes per the PRD's rule list. Pattern: delete prior
 * (entity_type, entity_id) rows when the validator re-runs, then insert
 * the new set in the same tx (addendum §4.5 row for this job).
 *
 * organization_id is denormalized so RLS keys on it directly without
 * joining through the polymorphic (entity_type, entity_id).
 */
export const validationResults = pgTable(
  "validation_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 'extracted_invoice' | 'document' | … */
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    passed: boolean("passed").notNull(),
    /** 'blocking' | 'warning' — drives the review queue's "Needs Review" filter. */
    severity: text("severity").notNull(),
    errorsJson: jsonb("errors_json").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index("idx_validation_results_entity").on(
      t.entityType,
      t.entityId,
    ),
  }),
);
