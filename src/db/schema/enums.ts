import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Status columns as ENUMs (addendum §4.3). Unknown statuses fail at the DB.
 */

export const userRole = pgEnum("user_role", [
  "owner",
  "admin",
  "reviewer",
  "clerk",
  "viewer",
]);

export const documentStatus = pgEnum("document_status", [
  "received",
  "processing",
  "text_extracted",
  "llm_extracted",
  "validation_failed",
  "review_required",
  "approved",
  "rejected",
  "exported",
  "failed",
]);

export const documentSource = pgEnum("document_source", [
  "upload",
  "email",
  "api",
]);

/**
 * Invoice review status (PRD + addendum §4.3).
 * `superseded` exists so retries of extract-invoice-data can soft-replace
 * a prior pending/needs_review row without violating the partial unique
 * index from §4.2.
 */
export const invoiceReviewStatus = pgEnum("invoice_review_status", [
  "pending",
  "needs_review",
  "pending_final_approval",
  "approved",
  "rejected",
  "exported",
  "superseded",
]);

/**
 * llm_runs.status — addendum §4.1 append-only model.
 *
 * `non_compliant_model` is distinct from `provider_error`: the latter
 * is a transient Anthropic 5xx (retry-appropriate); the former is a
 * policy violation (the registry refused to dispatch a model lacking
 * ZDR / wrong region / wrong retention). Keeping them separate
 * preserves audit fidelity. Added via sidecar 0027.
 */
export const llmRunStatus = pgEnum("llm_run_status", [
  "started",
  "succeeded",
  "schema_failed",
  "provider_error",
  "text_too_large",
  "quota_exceeded",
  "circuit_open",
  "non_compliant_model",
]);

/** export.format — file exports + accounting sync targets. */
export const exportFormat = pgEnum("export_format", ["csv", "json", "qbo", "xero", "netsuite", "intacct"]);

/** export.status — created up-front by the API; the job advances. */
export const exportStatus = pgEnum("export_status", [
  "created",
  "running",
  "completed",
  "failed",
]);

/**
 * email_messages.status (addendum §3.6).
 * - received       just landed; not yet processed
 * - processing     worker claimed it
 * - processed      one or more attachments accepted as documents
 * - no_attachments parsed cleanly but no valid attachment found
 * - unrouted       recipient address couldn't be resolved to an org/client
 * - failed         parser or storage failure; will retry from DLQ
 */
export const emailMessageStatus = pgEnum("email_message_status", [
  "received",
  "processing",
  "processed",
  "no_attachments",
  "unrouted",
  "failed",
]);

/** email_attachments.status (addendum §3.3). */
export const emailAttachmentStatus = pgEnum("email_attachment_status", [
  "received",
  "accepted",
  "rejected",
]);

/**
 * Phase 9.5 — document kind discriminator. process-document dispatches
 * to extract-invoice-data or extract-contract-data based on this. The
 * default is 'invoice' so the existing flow is unchanged; uploads can
 * opt-in to 'contract' via the upload route's documentKind field.
 */
export const documentKind = pgEnum("document_kind", [
  "invoice",
  "contract",
]);

/**
 * Phase 9.5 — vendor_contracts.status. Mirrors the invoice append-only
 * pattern: a contract is created in pending_extraction (no rate-card
 * yet), the extract-contract-data job advances to extracted on success,
 * an admin can activate (active) or supersede. expired is set by a
 * future scheduled job based on expiry_date.
 */
export const contractStatus = pgEnum("contract_status", [
  "pending_extraction",
  "extracted",
  "active",
  "superseded",
  "expired",
  "failed",
]);
