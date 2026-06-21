import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { clients } from "./clients";
import { users } from "./users";
import { emailMessages } from "./emailMessages";
import { emailAttachments } from "./emailAttachments";
import { documentStatus, documentSource, documentKind } from "./enums";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    /**
     * Provenance for source='email' documents. Both columns are populated
     * when the upload pipeline is the AP inbox; null otherwise.
     */
    emailMessageId: uuid("email_message_id").references(() => emailMessages.id, {
      onDelete: "set null",
    }),
    emailAttachmentId: uuid("email_attachment_id").references(
      () => emailAttachments.id,
      { onDelete: "set null" },
    ),
    source: documentSource("source").notNull(),
    /**
     * Phase 9.5 — discriminates the downstream extraction pipeline.
     * 'invoice' (default) → extract-invoice-data + validate.
     * 'contract' → extract-contract-data → vendor_contracts rate card.
     * Backfilled to 'invoice' for all pre-existing rows in the sidecar
     * migration so the column is NOT NULL safely.
     */
    kind: documentKind("kind").notNull().default("invoice"),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type"),
    storageKey: text("storage_key").notNull(),
    contentHash: text("content_hash"), // sha256, used for upload dedup
    pageCount: integer("page_count"),
    status: documentStatus("status").notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Dedup: same content within an org collapses to one document.
    orgContentHashUnique: uniqueIndex("documents_org_content_hash_uniq").on(
      t.organizationId,
      t.contentHash,
    ),
    orgStatus: index("idx_documents_org_status").on(t.organizationId, t.status),
    clientStatus: index("idx_documents_client_status").on(t.clientId, t.status),
    contentHashIdx: index("idx_documents_content_hash").on(t.contentHash),
    // PR20 — review queue sort key. Migration 0020 creates the SQL
    // index; declaration here keeps the schema-as-source-of-truth.
    orgReceivedIdx: index("idx_documents_org_received").on(
      t.organizationId,
      t.receivedAt.desc(),
    ),
  }),
);
