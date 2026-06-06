import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { emailMessages } from "./emailMessages";
import { emailAttachmentStatus } from "./enums";

/**
 * Per-attachment record (addendum §3). Even rejected attachments land here
 * with status='rejected' + rejection_reason so audit + DLQ telemetry can
 * show why a vendor's invoice didn't make it through.
 *
 * Accepted attachments produce a row in `documents` whose
 * `email_attachment_id` points back here.
 */
export const emailAttachments = pgTable(
  "email_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    emailMessageId: uuid("email_message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type"),
    /** Sniffed MIME type from magic bytes; may differ from header. */
    sniffedMimeType: text("sniffed_mime_type"),
    storageKey: text("storage_key").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    contentHash: text("content_hash"),
    status: emailAttachmentStatus("status").notNull().default("received"),
    /** Populated when status='rejected' — e.g. 'too_large', 'unsupported_mime'. */
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageIdx: index("idx_email_attachments_message").on(t.emailMessageId),
  }),
);
