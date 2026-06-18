-- PR5 — Phase 7 hotfix.
--
-- 1. New `normalize_vendor_text(text)` immutable function that mirrors
--    src/lib/validation/normalizeVendor exactly. Single source of truth for
--    vendor-name normalization in both JS and SQL. The recompute job and
--    any future functional index use it.
--
-- 2. Backfill match_method on legacy vendor_matches rows. The Phase 7
--    migration added the column without a default; pre-Phase-7 rows
--    have NULL, which broke the bootstrap branching logic.

-- ---------------------------------------------------------------------------
-- 1. normalize_vendor_text
--    JS reference (src/lib/validation/index.ts:duplicateKey/normalizeVendor):
--      name.toLowerCase()
--          .replace(/[^a-z0-9\s]/g, " ")
--          .replace(/\s+/g, " ")
--          .trim()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_vendor_text(s text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(lower(s), '[^a-z0-9 ]+', ' ', 'g'),
      '\s+', ' ', 'g'
    )
  )
$$;

GRANT EXECUTE ON FUNCTION normalize_vendor_text(text)
  TO app_user, app_worker, app_admin;

-- ---------------------------------------------------------------------------
-- 2. Backfill match_method on legacy vendor_matches rows.
--    Pre-Phase-7 rows have NULL because 0009 added the column without
--    a default. Default for linked rows: assume canonical (most common
--    pre-Phase-7 matcher path). Unlinked rows: 'none'.
-- ---------------------------------------------------------------------------
UPDATE vendor_matches
   SET match_method = 'exact_normalized'
 WHERE match_method IS NULL
   AND vendor_id IS NOT NULL;

UPDATE vendor_matches
   SET match_method = 'none'
 WHERE match_method IS NULL
   AND vendor_id IS NULL;
