-- PR4 — scale-prep indexes from the perf review.
--
-- 1. llm_runs (review #18): the quota lookup filters on
--    (organization_id, status IN (…), created_at >= today). The existing
--    idx_llm_runs_org_created handles org + created_at but recheck on
--    status still hits the heap. Add a partial index over the metered
--    statuses so the count is index-only.
--
-- 2. validation_results (review #24): an active-row lookup ordered by
--    created_at benefits from the column being IN the index, not just
--    the filter. The partial index added in 0007_pr2_invariants.sql
--    already includes created_at; this migration is a no-op for that
--    column. Listed here for documentation completeness.

CREATE INDEX IF NOT EXISTS idx_llm_runs_quota
  ON llm_runs(organization_id, created_at DESC)
  WHERE status IN ('succeeded', 'schema_failed', 'provider_error');
