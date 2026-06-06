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
