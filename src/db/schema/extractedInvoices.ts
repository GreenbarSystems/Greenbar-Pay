import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  numeric,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { clients } from "./clients";
import { documents } from "./documents";
import { users } from "./users";
import { llmRuns } from "./llmRuns";
import { invoiceReviewStatus } from "./enums";

/**
 * Header-level extracted invoice. Addendum §4.2 — supersede pattern:
 *   The partial unique index `uniq_extracted_invoices_active`
 *   (see migrations/sidecar/0003_rls_phase3.sql) enforces at most one
 *   row per document where review_status ∈ ('pending', 'needs_review').
 *
 * Retries of extract-invoice-data soft-replace the active row:
 *   UPDATE … SET review_status='superseded' WHERE review_status IN (…)
 *   INSERT new row.
 *
 * Approved/rejected/exported rows are NEVER superseded — if a reviewer
 * has acted, an upstream-job retry is rejected with a structured error.
 */
export const extractedInvoices = pgTable(
  "extracted_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    llmRunId: uuid("llm_run_id").references(() => llmRuns.id, {
      onDelete: "set null",
    }),
    documentType: text("document_type").notNull().default("invoice"),
    vendorName: text("vendor_name"),
    vendorAddress: text("vendor_address"),
    remitToName: text("remit_to_name"),
    remitToAddress: text("remit_to_address"),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date"),
    dueDate: date("due_date"),
    paymentTerms: text("payment_terms"),
    purchaseOrderNumber: text("purchase_order_number"),
    currency: text("currency").default("USD"),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }),
    tax: numeric("tax", { precision: 14, scale: 2 }),
    shipping: numeric("shipping", { precision: 14, scale: 2 }),
    discount: numeric("discount", { precision: 14, scale: 2 }),
    total: numeric("total", { precision: 14, scale: 2 }),
    confidence: text("confidence"), // 'low' | 'medium' | 'high'
    warningsJson: jsonb("warnings_json").notNull().default([]),
    reviewStatus: invoiceReviewStatus("review_status").notNull().default("pending"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgReview: index("idx_extracted_invoices_org_review_status").on(
      t.organizationId,
      t.reviewStatus,
    ),
    vendorInvoice: index("idx_extracted_invoices_vendor_invoice").on(
      t.organizationId,
      t.vendorName,
      t.invoiceNumber,
    ),
    docIdx: index("idx_extracted_invoices_document_id").on(t.documentId),
  }),
);

export const extractedInvoiceLines = pgTable(
  "extracted_invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    extractedInvoiceId: uuid("extracted_invoice_id")
      .notNull()
      .references(() => extractedInvoices.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number"),
    description: text("description"),
    quantity: numeric("quantity", { precision: 14, scale: 4 }),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    /**
     * Phase 9 — F06 line-item confidence scoring. Populated by
     * validateExtractedInvoice when the line is scored against
     * vendor_pricing_history (which acts as the stats table). Null when
     * the line was never scored (legacy or no matched vendor).
     *
     *   'high'   — keyword seen ≥ 5 invoices, price within 1σ
     *   'medium' — seen 2–4 invoices OR price 1–2σ from avg
     *   'low'    — seen 0–1 invoices with price provided OR price > 2σ
     *   'new'    — keyword never seen for this vendor before
     */
    confidenceScore: text("confidence_score"),
    confidenceReason: text("confidence_reason"),
    histSampleCount: integer("hist_sample_count"),
    histAvgPrice: numeric("hist_avg_price", { precision: 14, scale: 4 }),
    histStddevPrice: numeric("hist_stddev_price", { precision: 14, scale: 4 }),
    /** |unit_price − avg| / stddev — null when stddev is null. */
    stddevDistance: numeric("stddev_distance", { precision: 7, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * PR12 M5 — null on legacy rows; written by every confidence
     * UPDATE from runValidationInTx so each row carries the DB clock
     * at last score time. Lets auditors order revalidation events
     * and pair them with the corresponding validation_results row.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    parentIdx: index("idx_extracted_invoice_lines_parent").on(
      t.extractedInvoiceId,
    ),
  }),
);
