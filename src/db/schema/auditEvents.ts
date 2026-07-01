import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  bigserial,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Append-only (addendum §4.1). Every mutation, approval, rejection, export,
 * and admin (BYPASSRLS) session lands here.
 *
 * RANGE-partitioned by created_at (monthly) as of migration 0030 — see
 * that file for the full design rationale and
 * src/jobs/ensureAuditEventPartitions.ts for the scheduled job that
 * keeps future partitions created ahead of the calendar.
 *
 * PRIMARY KEY is (id, created_at), not just (id): Postgres requires
 * the partition key to be part of any PK/UNIQUE constraint on a
 * partitioned table. `id` remains effectively unique in practice
 * (random UUID via defaultRandom()); no code does a single-column
 * eq(auditEvents.id, x) as a write target (the append-only RULES
 * block UPDATE/DELETE entirely regardless).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").notNull().defaultRandom(),
    // PR18 — append-only RULES + RESTRICT on org cascade. The system
    // of record for every other control must not silently disappear
    // when an organisation is deleted. RULES added in migration 0019.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(), // 'user' | 'worker' | 'admin' | 'system'
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * PR15 — strict-monotonic tie-breaker. Rows written inside the same
     * tx share created_at to the millisecond; the bigserial guarantees
     * ORDER BY (created_at, seq) reproduces the application's insert
     * order. Auditor queries can prove e.g. invoice.override_recorded
     * preceded invoice.approved without needing extra-transaction
     * timestamps.
     */
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.createdAt] }),
    entityIdx: index("idx_audit_events_entity").on(t.entityType, t.entityId),
    entitySeqIdx: index("idx_audit_events_entity_seq").on(
      t.entityType,
      t.entityId,
      t.createdAt,
      t.seq,
    ),
  }),
);
