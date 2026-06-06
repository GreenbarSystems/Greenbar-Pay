import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { documents } from "./documents";

/**
 * Append-only (addendum §4.1). Each `process-document` run lands a fresh
 * row; readers query `latest by created_at` for the active extraction.
 *
 * `organization_id` is denormalized so RLS can key on it directly (cleaner
 * than joining through `documents` in every policy check).
 */
export const documentExtractions = pgTable(
  "document_extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    method: text("method").notNull(), // 'native_pdf' | 'tesseract' | 'tesseract_pdf' | ...
    provider: text("provider"),
    rawTextStorageKey: text("raw_text_storage_key").notNull(),
    textLength: integer("text_length").notNull().default(0),
    qualityScore: numeric("quality_score", { precision: 5, scale: 4 }),
    averageConfidence: numeric("average_confidence", { precision: 5, scale: 4 }),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docLatest: index("idx_document_extractions_doc_latest").on(
      t.documentId,
      t.createdAt,
    ),
  }),
);
