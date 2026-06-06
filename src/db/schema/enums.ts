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
  "approved",
  "rejected",
  "exported",
  "superseded",
]);

/** llm_runs.status — addendum §4.1 append-only model. */
export const llmRunStatus = pgEnum("llm_run_status", [
  "started",
  "succeeded",
  "schema_failed",
  "provider_error",
  "text_too_large",
  "quota_exceeded",
  "circuit_open",
]);

/** export.format — generic CSV/JSON ship first; ERP CSVs later. */
export const exportFormat = pgEnum("export_format", ["csv", "json"]);

/** export.status — created up-front by the API; the job advances. */
export const exportStatus = pgEnum("export_status", [
  "created",
  "running",
  "completed",
  "failed",
]);
