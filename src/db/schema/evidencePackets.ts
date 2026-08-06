import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { extractedInvoices } from "./extractedInvoices";
import { documents } from "./documents";
import { users } from "./users";

/**
 * Phase 11 — D4 Audit-Ready Evidence Packet.
 *
 * One immutable row per approved invoice, assembled by the
 * `assemble-evidence-packet` pg-boss job after the approve commit.
 * The DB-level RULE on this table refuses UPDATE and DELETE — the
 * packet is a frozen attestation; re-assembly is not supported.
 *
 * Manifest content (manifest_json) follows the §D4 spec: full extracted
 * invoice JSON with confidence scores, the validation_results active
 * row, the briefing card, the vendor profile snapshot, the approver
 * action log including any override row, and the source document hash.
 * manifest_hash is a SHA-256 over a canonical (sorted-keys) JSON
 * serialisation — re-computing it from the row gives the same value
 * unless someone bypassed the rules and tampered with the row.
 */
export const evidencePackets = pgTable(
  "evidence_packets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // onDelete: "restrict" — MUST match sidecar migration 0018_pr15_audit_integrity.sql.
    // Cascade deletes bypass the append-only RULE on this table (FK triggers
    // run below RULE level), silently destroying sealed evidence with no
    // audit trail. If drizzle-kit ever regenerates a migration for this
    // table, it must not reintroduce CASCADE here.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    extractedInvoiceId: uuid("extracted_invoice_id")
      .notNull()
      .references(() => extractedInvoices.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    sealedAt: timestamp("sealed_at", { withTimezone: true }).notNull().defaultNow(),
    sealedByUserId: uuid("sealed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** SHA-256 over the canonical-JSON serialisation of manifest_json. */
    manifestHash: text("manifest_hash").notNull(),
    manifestJson: jsonb("manifest_json").notNull(),
    /** Re-verified copy of documents.content_hash at seal time. */
    sourceDocumentHash: text("source_document_hash").notNull(),
    /** NULL until a PDF render job lands. Phase 11 MVP ships JSON only. */
    pdfStorageKey: text("pdf_storage_key"),
    pdfGeneratedAt: timestamp("pdf_generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqPerInvoice: uniqueIndex("uniq_evidence_packet_per_invoice").on(
      t.organizationId,
      t.extractedInvoiceId,
    ),
    orgSealedIdx: index("idx_evidence_packets_org_sealed").on(
      t.organizationId,
      t.sealedAt.desc(),
    ),
  }),
);
