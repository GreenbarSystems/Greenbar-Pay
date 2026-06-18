-- PR2 — addendum/compliance invariants from the review.
--
-- 1. validation_results becomes append-only via a soft-supersede column
--    (review #4: hard DELETE destroyed prior-blocking evidence).
-- 2. api_idempotency_keys PK keys on (organization_id, key) so org A
--    cannot squat or collide with org B's keys (review #5).

-- ---------------------------------------------------------------------------
-- 1. validation_results: add `superseded_at`. Readers filter
--    `WHERE superseded_at IS NULL` for the active view.
-- ---------------------------------------------------------------------------
ALTER TABLE validation_results
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- Active-row index: cheap "latest active for entity" lookup.
CREATE INDEX IF NOT EXISTS idx_validation_results_active
  ON validation_results(entity_type, entity_id, created_at DESC)
  WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. api_idempotency_keys: PK on (organization_id, key).
--    Drop the old PK + recreate; the existing data (if any) needs the
--    composite to be uniquely satisfiable, which it is since the old
--    schema enforced key uniqueness globally.
-- ---------------------------------------------------------------------------
ALTER TABLE api_idempotency_keys
  DROP CONSTRAINT IF EXISTS api_idempotency_keys_pkey;

ALTER TABLE api_idempotency_keys
  ADD CONSTRAINT api_idempotency_keys_pkey
  PRIMARY KEY (organization_id, key);
