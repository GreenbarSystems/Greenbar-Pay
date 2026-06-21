/**
 * Phase 9.5 — vendor contracts (D3 second half).
 *
 * Phase 9 introduced statistical rate-drift validation (compare each
 * line's unit_price against the vendor's historical mean/stddev).
 * Phase 9.5 introduces *contract-grounded* validation: when an
 * uploaded vendor contract gives an explicit rate card, invoice lines
 * are checked against the contract first, and the statistical history
 * is the fallback.
 *
 * Two tables:
 *   - vendor_contracts: header (effective dates, payment terms, the
 *     parsed PDF reference, llm_run lineage). Append-only via the
 *     supersededAt column — a new upload supersedes the prior
 *     contract for that vendor.
 *   - vendor_contract_lines: the rate-card rows. `item_keyword` is
 *     pre-normalized via the same itemKeyword() helper Phase 9
 *     pricing-history already uses, so the future validation rule
 *     can do an indexed equality join against extracted invoice
 *     lines.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  integer,
  date,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { vendors } from "./vendors";
import { documents } from "./documents";
import { llmRuns } from "./llmRuns";
import { contractStatus } from "./enums";

export const vendorContracts = pgTable(
  "vendor_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /**
     * Nullable until vendor bootstrap can resolve. The
     * extract-contract-data job sets this either from an explicit upload
     * (admin chose the vendor) or by matching the extracted vendor name
     * against existing vendors. Without a vendor_id the contract sits
     * in `pending_extraction` waiting for an admin to resolve.
     */
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "restrict",
    }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    llmRunId: uuid("llm_run_id").references(() => llmRuns.id, {
      onDelete: "set null",
    }),
    /** Optional human reference (e.g. "MSA-2026-04") from the PDF. */
    contractNumber: text("contract_number"),
    /** ISO date — when the contract goes into effect. */
    effectiveDate: date("effective_date"),
    /** ISO date — when the contract expires; null = open-ended. */
    expiryDate: date("expiry_date"),
    /** Free-text payment terms from the contract (e.g. "Net 30"). */
    paymentTerms: text("payment_terms"),
    /** Early-payment discount % if the contract specifies one. */
    earlyPaymentDiscountPct: numeric("early_payment_discount_pct", {
      precision: 5,
      scale: 2,
    }),
    /** Days before due-date that the early-payment discount applies. */
    earlyPaymentDiscountDays: integer("early_payment_discount_days"),
    /** Default currency of the contract ('USD', 'EUR', etc.). */
    currency: text("currency"),
    status: contractStatus("status").notNull().default("pending_extraction"),
    /** Same low/medium/high band as extracted_invoices.confidence. */
    confidence: text("confidence"),
    /** Soft warnings surfaced by the LLM extraction (e.g. "no rate
     *  card found", "ambiguous expiry"). Never blocks the upload. */
    warningsJson: jsonb("warnings_json").notNull().default([]),
    /** Append-only supersede: a new active contract for the same
     *  (org, vendor) sets supersededAt on the prior row. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgVendorIdx: index("idx_vendor_contracts_org_vendor").on(
      t.organizationId,
      t.vendorId,
    ),
    orgStatusIdx: index("idx_vendor_contracts_org_status").on(
      t.organizationId,
      t.status,
    ),
    documentIdx: index("idx_vendor_contracts_document").on(t.documentId),
  }),
);

export const vendorContractLines = pgTable(
  "vendor_contract_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => vendorContracts.id, { onDelete: "cascade" }),
    /** The literal line label from the contract — "Premium Widget 24oz". */
    description: text("description").notNull(),
    /**
     * Normalized keyword for matching against invoice lines. Computed
     * via the same itemKeyword() helper used by Phase 9's pricing
     * history (lowercase, strip non-alphanumeric, drop stop words,
     * take first 3 meaningful tokens). NULL when the description has
     * no meaningful tokens — the future validation rule treats NULL
     * as "no match attempted".
     */
    itemKeyword: text("item_keyword"),
    /** The contracted unit price. */
    unitPrice: numeric("unit_price", { precision: 12, scale: 4 }),
    currency: text("currency"),
    /**
     * Basis: 'per_unit' | 'per_hour' | 'flat' | 'tiered'. Free text
     * for now (the LLM may emit variants); the validation rule will
     * normalize.
     */
    priceBasis: text("price_basis"),
    /** Optional quantity bracket from a tiered table. */
    minQuantity: numeric("min_quantity", { precision: 12, scale: 4 }),
    maxQuantity: numeric("max_quantity", { precision: 12, scale: 4 }),
    /** Free-text terms specific to this line (e.g. "expires 2026-12-31"). */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    contractIdx: index("idx_vendor_contract_lines_contract").on(t.contractId),
    /**
     * (org, item_keyword) lets the future validation rule do an
     * indexed equality lookup of "what's the contracted rate for
     * keyword X across this org's active contracts?" without
     * scanning per-vendor. Partial-style — keyword NULL rows are
     * harmless dead entries that never get matched.
     */
    orgKeywordIdx: index("idx_vendor_contract_lines_org_keyword").on(
      t.organizationId,
      t.itemKeyword,
    ),
  }),
);
