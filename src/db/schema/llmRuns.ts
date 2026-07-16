import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  integer,
  numeric,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { documents } from "./documents";
import { llmRunStatus } from "./enums";

/**
 * Append-only (addendum §4.1). Every LLM dispatch attempt gets a row —
 * success, schema failure, provider error, or pre-flight rejection
 * (text_too_large / quota_exceeded / circuit_open).
 *
 * Per §2.4, `output_json` may contain extracted vendor/amount data and
 * is the only field allowed to carry it. App logs (stdout, APM) get
 * IDs only — the scrubber in src/lib/llm/scrub.ts enforces this.
 */
export const llmRuns = pgTable(
  "llm_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(), // 'anthropic' | 'openai' | …
    model: text("model").notNull(), // e.g. 'claude-sonnet-4-5-20251001'
    promptName: text("prompt_name").notNull(),
    promptVersion: text("prompt_version").notNull(),
    /** sha256 of the rendered prompt — never the prompt text itself (§2.4). */
    inputHash: text("input_hash"),
    inputTokensEstimate: integer("input_tokens_estimate"),
    /** Actual input tokens from the provider response (null for pre-flight failures). */
    inputTokens: integer("input_tokens"),
    /** Actual output tokens from the provider response (null for pre-flight failures). */
    outputTokens: integer("output_tokens"),
    /** (inputTokens * inputCostPerMToken + outputTokens * outputCostPerMToken) / 1_000_000 */
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 6 }),
    outputJson: jsonb("output_json"),
    status: llmRunStatus("status").notNull(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docLatest: index("idx_llm_runs_doc_latest").on(t.documentId, t.createdAt),
    orgCreated: index("idx_llm_runs_org_created").on(
      t.organizationId,
      t.createdAt,
    ),
  }),
);
