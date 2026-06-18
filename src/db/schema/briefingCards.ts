import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { extractedInvoices } from "./extractedInvoices";
import { llmRuns } from "./llmRuns";

/**
 * Briefing Card snapshots (Phase 8 — D2).
 *
 * Append-only with `superseded_at` — same pattern as validation_results.
 * On every regeneration (post-revalidation), the prior active row is
 * soft-superseded so the evidence chain stays intact. The spec's
 * "Briefing Card snapshot frozen at moment of approval" maps to the
 * active row picked at approve time, which goes into the evidence
 * packet in Phase 11.
 *
 * Risk score is the DETERMINISTIC compute (src/lib/briefing/risk-score.ts);
 * risk_justification is the LLM-written one-sentence prose. Storing
 * them separately makes the score reproducible and the prose updatable
 * without rewriting history.
 */
export const briefingCards = pgTable(
  "briefing_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    extractedInvoiceId: uuid("extracted_invoice_id")
      .notNull()
      .references(() => extractedInvoices.id, { onDelete: "cascade" }),
    /** The LLM Call 2 dispatch that produced this card. */
    llmRunId: uuid("llm_run_id").references(() => llmRuns.id, {
      onDelete: "set null",
    }),
    /** Suggested GL account code; null when the model declined to suggest. */
    glCode: text("gl_code"),
    glRationale: text("gl_rationale").notNull(),
    /** [{code, severity, message}] — see briefing-card-schema.ts. */
    anomalyFlagsJson: jsonb("anomaly_flags_json").notNull().default([]),
    deltaSummary: text("delta_summary").notNull().default(""),
    /** Deterministic 0–100. */
    riskScore: integer("risk_score").notNull(),
    /** LLM-written one-sentence justification of the score. */
    riskJustification: text("risk_justification").notNull(),
    /** Vendor profile snapshot at generation time — embedded for the evidence packet. */
    vendorContextJson: jsonb("vendor_context_json"),
    /** Risk factors that contributed (deterministic, computed). */
    riskFactorsJson: jsonb("risk_factors_json").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL = active. Set on supersede when regenerated. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    invoiceActiveIdx: index("idx_briefing_cards_invoice_active").on(
      t.extractedInvoiceId,
      t.createdAt,
    ),
  }),
);
