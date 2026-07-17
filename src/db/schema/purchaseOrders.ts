/**
 * PO Matching — purchase_orders, purchase_order_lines, po_match_results.
 *
 * Conventions match vendorContracts.ts: uuid PKs, organization_id FK,
 * append-only po_match_results with superseded_at, indexes mirroring
 * the vendor_contract_lines org+keyword pattern.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  date,
  jsonb,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations";
import { clients } from "./clients";
import { vendors } from "./vendors";
import { users } from "./users";
import { extractedInvoices } from "./extractedInvoices";

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "restrict",
    }),
    poNumber: text("po_number").notNull(),
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "restrict",
    }),
    vendorName: text("vendor_name"),
    issueDate: date("issue_date"),
    expiryDate: date("expiry_date"),
    currency: text("currency").notNull().default("USD"),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }),
    tax: numeric("tax", { precision: 14, scale: 2 }),
    shipping: numeric("shipping", { precision: 14, scale: 2 }),
    total: numeric("total", { precision: 14, scale: 2 }).notNull(),
    /** 'open' | 'partially_received' | 'received' | 'closed' | 'cancelled' */
    status: text("status").notNull().default("open"),
    receiptConfirmedAt: timestamp("receipt_confirmed_at", { withTimezone: true }),
    receiptConfirmedBy: uuid("receipt_confirmed_by").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgPoNumberUniq: unique("purchase_orders_org_po_number_unique").on(
      t.organizationId,
      t.poNumber,
    ),
    orgStatusIdx: index("idx_purchase_orders_org_status").on(
      t.organizationId,
      t.status,
    ),
    vendorIdx: index("idx_purchase_orders_vendor_id").on(t.vendorId),
  }),
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    description: text("description").notNull(),
    /** Normalized via itemKeyword() — same helper as vendor contract lines. */
    itemKeyword: text("item_keyword"),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    receivedQuantity: numeric("received_quantity", { precision: 14, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    poLineUniq: unique("purchase_order_lines_po_line_unique").on(
      t.purchaseOrderId,
      t.lineNumber,
    ),
    poIdx: index("idx_po_lines_po_id").on(t.purchaseOrderId),
    orgKeywordIdx: index("idx_po_lines_org_keyword").on(
      t.organizationId,
      t.itemKeyword,
    ),
  }),
);

export const poMatchResults = pgTable(
  "po_match_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    extractedInvoiceId: uuid("extracted_invoice_id")
      .notNull()
      .references(() => extractedInvoices.id, { onDelete: "restrict" }),
    purchaseOrderId: uuid("purchase_order_id").references(
      () => purchaseOrders.id,
      { onDelete: "restrict" },
    ),
    /** '2-way' | '3-way' | null (when no PO was found) */
    matchType: text("match_type"),
    /**
     * 'matched' | 'amount_exceeded' | 'not_found' | 'closed' |
     * 'receipt_not_confirmed' | 'line_quantity_variance'
     */
    status: text("status").notNull(),
    invoiceTotal: numeric("invoice_total", { precision: 14, scale: 2 }),
    poTotal: numeric("po_total", { precision: 14, scale: 2 }),
    variancePct: numeric("variance_pct", { precision: 7, scale: 4 }),
    lineVariancesJson: jsonb("line_variances_json"),
    matchedAt: timestamp("matched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    activeIdx: uniqueIndex("idx_po_match_results_active")
      .on(t.organizationId, t.extractedInvoiceId)
      .where(sql`superseded_at IS NULL`),
    invoiceIdx: index("idx_po_match_results_invoice_id").on(
      t.extractedInvoiceId,
    ),
  }),
);

export type PurchaseOrderInsert = typeof purchaseOrders.$inferInsert;
export type PurchaseOrderSelect = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLineInsert = typeof purchaseOrderLines.$inferInsert;
export type PurchaseOrderLineSelect = typeof purchaseOrderLines.$inferSelect;
export type PoMatchResultInsert = typeof poMatchResults.$inferInsert;
export type PoMatchResultSelect = typeof poMatchResults.$inferSelect;
