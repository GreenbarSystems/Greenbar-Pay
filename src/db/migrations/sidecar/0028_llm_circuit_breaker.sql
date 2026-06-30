-- Shared LLM circuit-breaker state (addendum §2.7).
--
-- Replaces the previous per-worker in-memory implementation. The
-- problems with in-memory state:
--
--   1. Restart storm: a worker that restarts during a provider outage
--      starts with a clean circuit and fires MIN_SAMPLES (8) more
--      requests before re-tripping. Across a fleet, every redeploy or
--      crash adds 8× replicas more wasted requests.
--   2. No cross-replica coordination: a 5-replica fleet observes the
--      same provider failure 5× independently before all five trip;
--      that's 5 × 8 = 40 failing dispatches before fleet-wide circuit
--      opens.
--
-- Both go away when state is shared. A DB trigger on llm_runs INSERT
-- evaluates the rolling 5-minute window across all replicas atomically;
-- opened_at is set in a single, cross-tenant row. checkCircuit() in
-- application code just reads this row.

CREATE TABLE IF NOT EXISTS llm_circuit_state (
  provider   TEXT PRIMARY KEY,
  opened_at  TIMESTAMPTZ
);

GRANT SELECT, INSERT, UPDATE, DELETE ON llm_circuit_state TO app_user, app_worker;

-- Cross-tenant by design. Provider health is global, not per-org.
-- If anyone enables RLS here, every dispatch becomes a per-org check
-- that defeats fleet-wide coordination.
ALTER TABLE llm_circuit_state DISABLE ROW LEVEL SECURITY;

-- Supports the trigger's window count.
CREATE INDEX IF NOT EXISTS idx_llm_runs_provider_recent
  ON llm_runs (provider, created_at DESC);

CREATE OR REPLACE FUNCTION llm_circuit_evaluate()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY DEFINER so the trigger reads llm_runs across all orgs
-- (RLS would otherwise scope it to the current GUC). Owned by
-- app_admin (BYPASSRLS) which is the role that ran this migration.
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total_count  INT;
  error_count  INT;
BEGIN
  -- Only outcomes that actually hit the provider count toward provider
  -- health. Pre-flight rejections (text_too_large, quota_exceeded,
  -- circuit_open, non_compliant_model) never dispatched.
  IF NEW.status NOT IN ('succeeded', 'schema_failed', 'provider_error') THEN
    RETURN NEW;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status IN ('schema_failed', 'provider_error'))
  INTO total_count, error_count
  FROM llm_runs
  WHERE provider = NEW.provider
    AND status IN ('succeeded', 'schema_failed', 'provider_error')
    AND created_at > now() - INTERVAL '5 minutes';

  -- §2.7: min 8 samples, 25% error rate.
  IF total_count >= 8 AND (error_count::float / total_count) >= 0.25 THEN
    INSERT INTO llm_circuit_state (provider, opened_at)
    VALUES (NEW.provider, now())
    ON CONFLICT (provider) DO UPDATE SET opened_at = EXCLUDED.opened_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_llm_circuit_evaluate ON llm_runs;
CREATE TRIGGER trg_llm_circuit_evaluate
  AFTER INSERT ON llm_runs
  FOR EACH ROW
  EXECUTE FUNCTION llm_circuit_evaluate();
