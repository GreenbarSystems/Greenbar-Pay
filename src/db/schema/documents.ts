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
import { documentStatus, documentSource } from "./enums";

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
    source: documentSource("source").notNull(),
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
  }),
);
