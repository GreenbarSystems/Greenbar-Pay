import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { clients } from "./clients";
import { emailMessageStatus } from "./enums";

/**
 * Inbound mail (addendum §3). One row per RFC 822 message.
 *
 * Idempotency key (§3.3): `provider_message_id = sha256(Message-ID || s3_key)`.
 * The UNIQUE (provider, provider_message_id) prevents double-ingest even
 * when SES retries the SQS delivery.
 *
 * §3.6 deltas added to the PRD spec:
 *   - raw_message_storage_key (S3 key of the .eml)
 *   - routing_address (the `ap+...@in.<domain>` we matched on)
 *   - status uses the email_message_status ENUM
 */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(), // 'ses' | 'postmark' | ...
    providerMessageId: text("provider_message_id").notNull(),
    /** Object-storage key for the raw RFC 822 .eml. */
    rawMessageStorageKey: text("raw_message_storage_key").notNull(),
    /** The `ap+org--client@in.<domain>` we matched on. */
    routingAddress: text("routing_address").notNull(),
    mailbox: text("mailbox").notNull(),
    fromEmail: text("from_email"),
    fromName: text("from_name"),
    subject: text("subject"),
    /** Body text is stored for audit and DLQ alerts. NOT sent to LLM (§2.3). */
    bodyText: text("body_text"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    status: emailMessageStatus("status").notNull().default("received"),
    /** Why this message ended in unrouted / no_attachments / failed. */
    statusReason: text("status_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqProvider: uniqueIndex("uniq_email_messages_provider_message").on(
      t.provider,
      t.providerMessageId,
    ),
    mailboxReceived: index("idx_email_messages_mailbox_received").on(
      t.mailbox,
      t.receivedAt,
    ),
    orgReceived: index("idx_email_messages_org_received").on(
      t.organizationId,
      t.receivedAt,
    ),
  }),
);
