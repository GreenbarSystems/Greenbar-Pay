/**
 * Per-provider circuit breaker (addendum §2.7).
 *
 *   "If LLM 5xx + schema-fail rate exceeds 25% over a 5-minute window,
 *    the gateway opens the circuit for that provider and falls back to
 *    the secondary model."
 *
 * Phase 3 only ships Anthropic, so a tripped circuit means: refuse to
 * dispatch, return a structured `circuit_open` error, and let the
 * caller record an llm_runs row with status='circuit_open'. The job
 * marks the document `review_required` with a warning — no LLM call.
 *
 * State is in-memory and per-worker process. A multi-worker fleet
 * effectively gets per-worker breakers; that's acceptable because
 * each worker independently observes the provider's health.
 */

const WINDOW_MS = 5 * 60 * 1000;
const THRESHOLD = 0.25;
const MIN_SAMPLES = 8; // don't open on the very first failure
const RESET_AFTER_MS = 30 * 1000; // probe again every 30s when open

type Outcome = "ok" | "error";
interface Event {
  at: number;
  outcome: Outcome;
}

interface State {
  events: Event[];
  openedAt: number | null;
}

const state = new Map<string, State>();

function getState(provider: string): State {
  let s = state.get(provider);
  if (!s) {
    s = { events: [], openedAt: null };
    state.set(provider, s);
  }
  return s;
}

function prune(s: State, now: number) {
  const cutoff = now - WINDOW_MS;
  while (s.events.length > 0 && s.events[0].at < cutoff) s.events.shift();
}

/** Call BEFORE dispatching. Throws nothing — returns the decision. */
export function checkCircuit(
  provider: string,
  now: number,
): { open: boolean; reason?: string } {
  const s = getState(provider);
  if (!s.openedAt) return { open: false };
  if (now - s.openedAt >= RESET_AFTER_MS) {
    // Half-open: let one request through; the next record() decides whether
    // to close fully or re-open.
    s.openedAt = null;
    return { open: false };
  }
  return { open: true, reason: "circuit_open_for_provider" };
}

/** Call AFTER dispatching. `error` covers 5xx + schema failure. */
export function recordOutcome(
  provider: string,
  outcome: Outcome,
  now: number,
): void {
  const s = getState(provider);
  prune(s, now);
  s.events.push({ at: now, outcome });
  if (s.events.length < MIN_SAMPLES) return;
  const errs = s.events.reduce((n, e) => n + (e.outcome === "error" ? 1 : 0), 0);
  if (errs / s.events.length >= THRESHOLD) {
    s.openedAt = now;
  }
}

/** For tests. */
export function __resetCircuit() {
  state.clear();
}
