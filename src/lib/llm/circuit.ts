/**
 * Per-provider circuit breaker (addendum §2.7).
 *
 *   "If LLM 5xx + schema-fail rate exceeds 25% over a 5-minute window,
 *    the gateway opens the circuit for that provider and falls back to
 *    the secondary model."
 *
 * State lives in the shared `llm_circuit_state` table, populated by
 * a DB trigger on `llm_runs` INSERT (see migration
 * 0028_llm_circuit_breaker.sql). This replaces the previous
 * per-worker in-memory implementation, which had two known
 * deficiencies:
 *
 *   - Per-worker state lost the 8 MIN_SAMPLES headroom on every
 *     restart, so a deploy during a provider outage produced a
 *     thundering-herd of fresh dispatches before the circuit re-armed.
 *   - No cross-replica coordination: a 5-worker fleet had to
 *     independently observe MIN_SAMPLES failures each (40 total) before
 *     the breaker tripped fleet-wide.
 *
 * Both go away with shared state. The DB trigger runs SECURITY DEFINER
 * so it can read llm_runs across all orgs for the rate calculation
 * (RLS would otherwise scope to the current GUC).
 *
 * recordOutcome() is kept as an async no-op for call-site clarity —
 * the trigger is the actual writer. checkCircuit() is the read +
 * half-open probe path.
 */
import { eq } from "drizzle-orm";
import { rawWorkerDb } from "@/db/internal/rawClient";
import { llmCircuitState } from "@/db/schema";

const RESET_AFTER_MS = 30 * 1000; // probe again every 30s when open

type Outcome = "ok" | "error";

/** Call BEFORE dispatching. Resolves to the decision. */
export async function checkCircuit(
  provider: string,
  now: number,
): Promise<{ open: boolean; reason?: string }> {
  const rows = await rawWorkerDb
    .select({ openedAt: llmCircuitState.openedAt })
    .from(llmCircuitState)
    .where(eq(llmCircuitState.provider, provider));

  const openedAt = rows[0]?.openedAt;
  if (!openedAt) return { open: false };

  const sinceOpen = now - openedAt.getTime();
  if (sinceOpen >= RESET_AFTER_MS) {
    // Half-open: clear the row, let the next dispatch through. If it
    // errors, the next llm_runs INSERT trigger fires and re-opens.
    // DELETE rather than UPDATE-to-null so an INSERT ON CONFLICT in
    // the trigger always succeeds without a race.
    await rawWorkerDb
      .delete(llmCircuitState)
      .where(eq(llmCircuitState.provider, provider));
    return { open: false };
  }

  return { open: true, reason: "circuit_open_for_provider" };
}

/**
 * Call AFTER dispatching. Intentionally a no-op — the DB trigger on
 * `llm_runs` INSERT (trg_llm_circuit_evaluate) handles state.
 *
 * Kept in the API so call sites continue to read as if there's a
 * post-flight observation step; removing it would obscure the
 * dispatch → record symmetry. The parameters are unused but accepted
 * for backward compat.
 */
export async function recordOutcome(
  _provider: string,
  _outcome: Outcome,
  _now: number,
): Promise<void> {
  // Trigger is the writer. See migration 0028.
}

/** For tests. Clears all provider state. */
export async function __resetCircuit(): Promise<void> {
  await rawWorkerDb.delete(llmCircuitState);
}
