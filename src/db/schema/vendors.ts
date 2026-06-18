import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  numeric,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { clients } from "./clients";
import { extractedInvoices } from "./extractedInvoices";

/**
 * Vendor master + longitudinal profile (Phase 7 — D1 from the updated
 * MVP spec). The pre-Phase-7 columns are master data; the new columns
 * are derived stats refreshed by the `recompute-vendor-profile` job
 * on every invoice approval.
 *
 * The spec says the profile "becomes meaningful after three or more
 * invoices from the same vendor" — readers should gate display of
 * the derived stats on `invoice_count >= 3`.
 */
export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    /** Lowercased, punctuation-stripped, whitespace-normalized; used for matching. */
    normalizedName: text("normalized_name").notNull(),
    /**
     * Variant spellings the matcher has seen — e.g. "ABC Supplies" vs
     * "A.B.C. Supplies LLC" both normalize differently, so we keep all
     * variants here to make future fuzzy matches faster + more accurate.
     * Updated on every approve that resolved via fuzzy (non-exact) match.
     */
    aliases: text("aliases").array().notNull().default([]),
    status: text("status").notNull().default("active"),
    defaultPaymentTerms: text("default_payment_terms"),
    /** Most-common GL code across approved invoices. Phase 8 populates from coding history. */
    defaultGlCode: text("default_gl_code"),
    externalVendorId: text("external_vendor_id"),

    /** Profile stats (Phase 7) — recomputed from approved invoices. */
    invoiceCount: integer("invoice_count").notNull().default(0),
    lastInvoiceDate: date("last_invoice_date"),
    /** Rolling 30-day spend total in vendor's most-common currency. */
    spend30d: numeric("spend_30d", { precision: 16, scale: 2 }).notNull().default("0"),
    /** Rolling 90-day spend total. */
    spend90d: numeric("spend_90d", { precision: 16, scale: 2 }).notNull().default("0"),
    /** Mean total across all approved invoices from this vendor. */
    avgInvoiceAmount: numeric("avg_invoice_amount", {
      precision: 16,
      scale: 2,
    }).notNull().default("0"),
    /** Incremented when validation flags duplicate_invoice for this vendor. */
    duplicateSubmissionCount: integer("duplicate_submission_count").notNull().default(0),
    /** Set when the latest approved invoice's terms differ from defaultPaymentTerms. */
    termsDriftDetected: boolean("terms_drift_detected").notNull().default(false),
    lastProfileUpdated: timestamp("last_profile_updated", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOrgNormalized: uniqueIndex("uniq_vendors_org_normalized").on(
      t.organizationId,
      t.normalizedName,
    ),
    orgIdx: index("idx_vendors_org").on(t.organizationId),
  }),
);

/**
 * Per-(vendor, item_keyword) pricing history. Item keyword is a normalized
 * stem of the line description (lowercased, stop-words removed). Aggregated
 * by the profile recompute job from approved invoice line items.
 *
 * Drives the rate-drift validation rule in Phase 7 and the contract
 * variance rule in Phase 10.
 */
/**
 * PR6 — review #4: append-only with `superseded_at`. Same pattern as
 * validation_results (PR2) and briefing_cards (Phase 8). Each
 * recompute soft-supersedes any prior active row for the
 * (vendor, keyword) pair and inserts a fresh one. The active view is
 * `WHERE superseded_at IS NULL`, served by the partial index.
 *
 * The old `uniq_vendor_pricing_vendor_keyword` UNIQUE index is replaced
 * by a partial unique index on the active row only — multiple
 * superseded rows for the same (vendor, keyword) are valid (and
 * desired) so the historical trail survives.
 */
export const vendorPricingHistory = pgTable(
  "vendor_pricing_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    /** Lowercased, stemmed line description used as the grouping key. */
    itemKeyword: text("item_keyword").notNull(),
    /** Mean unit price across the captured samples. */
    avgUnitPrice: numeric("avg_unit_price", { precision: 16, scale: 4 }).notNull(),
    /** Sample count contributing to this row. */
    samples: integer("samples").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL = active. Set by recompute when a fresh aggregate replaces this row. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    vendorIdx: index("idx_vendor_pricing_vendor").on(t.vendorId),
  }),
);

/**
 * One row per extraction × match attempt. Append-only — vendor_matches
 * are recomputed on every retry of the validation step and we want the
 * history visible.
 */
export const vendorMatches = pgTable(
  "vendor_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    extractedInvoiceId: uuid("extracted_invoice_id")
      .notNull()
      .references(() => extractedInvoices.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
    /** 'low' | 'medium' | 'high' — PRD wording. */
    matchConfidence: text("match_confidence").notNull(),
    matchScore: numeric("match_score", { precision: 5, scale: 4 }),
    /**
     * Indicates HOW the match resolved — `exact_normalized`,
     * `exact_alias`, `jaccard`, `null` (no candidates). Phase 7
     * promotes a `jaccard` match's extracted vendor name into
     * `vendors.aliases` after approve so the next invoice resolves
     * via `exact_alias`.
     */
    matchMethod: text("match_method"),
    candidatesJson: jsonb("candidates_json").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index("idx_vendor_matches_invoice").on(t.extractedInvoiceId),
  }),
);

