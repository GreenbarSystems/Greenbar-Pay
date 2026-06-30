-- Partial index optimising the api_idempotency_keys TTL cleanup query.
--
-- The cleanup job (handle_cleanup_idempotency_keys) runs hourly and
-- deletes rows older than 24 hours. Without an index leading on
-- created_at, that DELETE is a sequential scan over the (org_id, key)
-- B-tree — fast at hundreds of rows, painful at millions.
--
-- The partial WHERE clause keeps the index tiny: it only indexes rows
-- already past the TTL boundary, so its size is bounded by
-- (cleanup_interval) * (insert rate) — never grows.
--
-- IF NOT EXISTS so this migration is replayable on environments that
-- somehow created it manually.
CREATE INDEX IF NOT EXISTS idx_api_idempotency_keys_cleanup
  ON api_idempotency_keys (created_at)
  WHERE created_at < (now() - INTERVAL '24 hours');
