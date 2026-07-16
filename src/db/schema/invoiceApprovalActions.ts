import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { extractedInvoices } from "./extractedInvoices";
import { users } from "./users";

/**
 * Per-stage approval actions for multi-step approval workflows.
 *
 * stageOrder 1 = initial review (reviewer+); 2 = final approval (admin+).
 * action: 'stage_approved' | 'rejected'
 *
 * Single-stage orgs skip this table entirely — their approvals go straight
 * to extracted_invoices.review_status = 'approved'.
 */
export const invoiceApprovalActions = pgTable(
  "invoice_approval_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    extractedInvoiceId: uuid("extracted_invoice_id")
      .notNull()
      .references(() => extractedInvoices.id, { onDelete: "cascade" }),
    stageOrder: integer("stage_order").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index("idx_invoice_approval_actions_invoice").on(t.extractedInvoiceId),
    orgIdx: index("idx_invoice_approval_actions_org").on(t.organizationId),
  }),
);
