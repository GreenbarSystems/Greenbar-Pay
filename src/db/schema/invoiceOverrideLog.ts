import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations";
import { extractedInvoices } from "./extractedInvoices";
import { documents } from "./documents";
import { users } from "./users";

/**
 * Phase 11 — F02 Stop Work Authority.
 *
 * Append-only ledger of every "approve despite blocking findings" event.
 * The DB-level RULE refuses UPDATE/DELETE: once an override is recorded
 * it cannot be silently retracted. An approver who later regrets the
 * call can supersede by rejecting the invoice (new event, new row),
 * but the original row stands.
 *
 * Drizzle does not natively know about Postgres INET — the schema
 * declares it as text() so reads succeed; writes are produced via
 * sql`$ip::inet` in the route to keep the on-disk type correct.
 */
export const invoiceOverrideLog = pgTable(
  "invoice_override_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    extractedInvoiceId: uuid("extracted_invoice_id")
      .notNull()
      .references(() => extractedInvoices.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    overridingUserId: uuid("overriding_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "set null" }),
    /** Optional second-approver per the F02 spec. Captured when present;
     *  no minimum-amount threshold enforced in the MVP. */
    secondApproverId: uuid("second_approver_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** CHECK char_length >= 20 enforced in the migration. */
    justificationText: text("justification_text").notNull(),
    overrideAmount: numeric("override_amount", { precision: 14, scale: 2 }),
    /** Snapshot of the blocking finding codes that were waived. */
    blockingFindingCodes: jsonb("blocking_finding_codes").notNull().default([]),
    /** Postgres INET column; Drizzle treats it as text on read. */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    orgApprovedIdx: index("idx_override_log_org_approved").on(
      t.organizationId,
      t.approvedAt.desc(),
    ),
    invoiceIdx: index("idx_override_log_invoice").on(
      t.organizationId,
      t.extractedInvoiceId,
    ),
  }),
);
