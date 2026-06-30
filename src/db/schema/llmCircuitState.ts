import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Shared LLM circuit-breaker state (addendum §2.7).
 *
 * One row per LLM provider. `opened_at` is set by the
 * trg_llm_circuit_evaluate DB trigger (migration 0028) when the
 * rolling 5-minute error rate crosses 25% with at least 8 samples.
 * The application layer (src/lib/llm/circuit.ts) reads this row to
 * decide whether to admit a dispatch, and clears the row after
 * RESET_AFTER_MS for half-open probing.
 *
 * Cross-tenant by design — no RLS. Provider health is global, not
 * per-org. The trigger uses SECURITY DEFINER to read llm_runs across
 * all orgs for the rate calculation.
 */
export const llmCircuitState = pgTable("llm_circuit_state", {
  provider: text("provider").primaryKey(),
  openedAt: timestamp("opened_at", { withTimezone: true }),
});
