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
 * Validation outcomes per the PRD's rule list.
 *
 * Append-only since PR2 — `superseded_at` is set when a fresh validation
 * run replaces a prior row, instead of hard DELETE. This preserves the
 * evidence chain: an auditor reviewing why an invoice with a mismatched
 * total was eventually approved can still see the blocking finding that
 * existed before the reviewer's edit cleared it.
 *
 * Active view: WHERE superseded_at IS NULL. The partial index
 * `idx_validation_results_active` covers that lookup ordered by
 * created_at DESC (see migrations/sidecar/0007_pr2_invariants.sql).
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
    /**
     * Set when a fresh validation run replaces this row. NULL for the
     * currently-active result. Soft-supersede, not delete — see the
     * migration sidecar for the partial index that makes filtering cheap.
     */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    entityIdx: index("idx_validation_results_entity").on(
      t.entityType,
      t.entityId,
    ),
  }),
);
