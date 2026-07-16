import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { clients } from "./clients";
import { users } from "./users";
import { extractedInvoices } from "./extractedInvoices";
import { exportFormat, exportStatus } from "./enums";

/**
 * Exports row is created UP-FRONT by the POST /api/ap/exports handler
 * (addendum §4.5 row for this job). The export-invoices worker idempotently
 * advances `status` via compare-and-set; the API endpoint is idempotent on
 * Idempotency-Key.
 */
export const exports = pgTable(
  "exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    format: exportFormat("format").notNull(),
    /** Object-storage key for the rendered file. Null until the job completes. */
    storageKey: text("storage_key"),
    /** Bytes; nice for UI and quota tracking. */
    fileSizeBytes: integer("file_size_bytes"),
    /** Number of invoices in the export — denormalized for cheap list display. */
    itemCount: integer("item_count").notNull().default(0),
    status: exportStatus("status").notNull().default("created"),
    errorMessage: text("error_message"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    orgCreated: index("idx_exports_org_created").on(t.organizationId, t.createdAt),
  }),
);

/**
 * One row per invoice included in an export. Status='included' is the
 * normal case; future ERP integrations may use 'failed' to track per-item
 * sync errors without failing the whole batch.
 */
export const exportItems = pgTable(
  "export_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    exportId: uuid("export_id")
      .notNull()
      .references(() => exports.id, { onDelete: "cascade" }),
    extractedInvoiceId: uuid("extracted_invoice_id")
      .notNull()
      .references(() => extractedInvoices.id),
    /** 'included' for CSV/JSON; 'synced'/'sync_failed' for QBO/Xero. */
    status: text("status").notNull().default("included"),
    /** QBO Bill ID or Xero Invoice ID after a successful sync. */
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    exportIdx: index("idx_export_items_export").on(t.exportId),
  }),
);
