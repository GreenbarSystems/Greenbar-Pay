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
--    Drop whatever PK currently exists and add the canonical-name PK.
--    Historical context: pre-PR2 the schema declared a single-column PK
--    on `key` (named api_idempotency_keys_pkey). PR2 made it composite.
--    Once drizzle-kit migrations were committed (issue #3), the init.sql
--    also creates the composite PK but with the drizzle-generated name
--    `api_idempotency_keys_organization_id_key_pk`. Either way, drop
--    any existing PK first so the ADD succeeds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name
  FROM pg_constraint
  WHERE conrelid = 'api_idempotency_keys'::regclass
    AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE api_idempotency_keys DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

ALTER TABLE api_idempotency_keys
  ADD CONSTRAINT api_idempotency_keys_pkey
  PRIMARY KEY (organization_id, key);
