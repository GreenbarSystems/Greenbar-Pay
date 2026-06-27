/**
 * Correction capture table for RAG-augmented briefing cards (Slice 2).
 *
 * One row per approved invoice that had reviewer PATCH edits before
 * approval. Stores the field-level diff plus a voyage-3 embedding
 * of the correction context for cosine-similarity retrieval in
 * generateBriefingCard.
 *
 * The embedding column is null until the capture-and-embed job runs.
 * A null embedding falls back to vendor_id-based retrieval in the
 * briefing job — the data flywheel starts accumulating diffs
 * immediately, embeddings catch up asynchronously.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { extractedInvoices } from "./extractedInvoices";
import { vendors } from "./vendors";

// pgvector custom column type — 1024-dimensional voyage-3 embeddings.
// We handle serialization here so callers can work with number[].
// The migration enables the vector extension before CREATE TABLE.
const vectorColumn = customType<{
  data: number[];
  config: { dimensions: number };
  driverData: string;
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(",").map(Number);
  },
});

export const extractionCorrections = pgTable(
  "extraction_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    extractedInvoiceId: uuid("extracted_invoice_id")
      .notNull()
      .references(() => extractedInvoices.id, { onDelete: "cascade" }),
    // Null when the vendor bootstrap hadn't resolved at capture time.
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
    // [{field, extracted, corrected}] — field-level diff from audit events.
    correctedFields: jsonb("corrected_fields")
      .$type<CorrectedField[]>()
      .notNull(),
    // Text sent to Voyage AI for embedding. Vendor name is included
    // (same risk class as invoice text sent to Anthropic). Exact dollar
    // amounts are bucketed to reduce PII precision at the API boundary.
    contextText: text("context_text").notNull(),
    // voyage-3 1024-dim embedding. Null until capture-and-embed job runs.
    embedding: vectorColumn("embedding", { dimensions: 1024 }),
    // DB clock from the approve tx timestamp (passed in job payload).
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Fast fallback retrieval by vendor when embeddings aren't available.
    vendorIdx: index("idx_extraction_corrections_vendor").on(t.vendorId),
    // Org-scoped time ordering for recent-corrections fallback.
    orgConfirmedIdx: index("idx_extraction_corrections_org_confirmed").on(
      t.organizationId,
      t.confirmedAt,
    ),
  }),
);

// Shared across schema, corrections lib, and job handler.
export interface CorrectedField {
  field: string;
  extracted: string | null;
  corrected: string | null;
}
