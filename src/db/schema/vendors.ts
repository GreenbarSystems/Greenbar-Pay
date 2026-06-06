import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { clients } from "./clients";
import { extractedInvoices } from "./extractedInvoices";

/**
 * Vendor master. Phase 4 only reads vendors for matching — write paths
 * for vendor onboarding land later (non-goal: no autonomous vendor
 * creation, per PRD).
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
    status: text("status").notNull().default("active"),
    defaultPaymentTerms: text("default_payment_terms"),
    externalVendorId: text("external_vendor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Unique normalized name within an org. Two clients in the same org
    // can collide via clientId scoping at the app layer if it matters.
    uniqOrgNormalized: uniqueIndex("uniq_vendors_org_normalized").on(
      t.organizationId,
      t.normalizedName,
    ),
    orgIdx: index("idx_vendors_org").on(t.organizationId),
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
    candidatesJson: jsonb("candidates_json").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index("idx_vendor_matches_invoice").on(t.extractedInvoiceId),
  }),
);
