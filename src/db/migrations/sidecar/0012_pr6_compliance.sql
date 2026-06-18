-- PR6 — compliance gaps from the post-Phase-7+8 review.
--
-- 1. vendor_pricing_history becomes append-only with superseded_at.
--    Replaces the uniq_vendor_pricing_vendor_keyword UNIQUE index
--    with a PARTIAL unique on active rows only.
--
-- 2. briefing_cards gains risk_score_version so a weight-table change
--    in the future is detectable in historical rows. NOT NULL with a
--    default for the migration; future inserts pass it explicitly.

-- ---------------------------------------------------------------------------
-- 1. vendor_pricing_history — append-only
-- ---------------------------------------------------------------------------
ALTER TABLE vendor_pricing_history
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- Drop the old full-table UNIQUE and replace with a partial one on the
-- active row only. Multiple superseded rows for the same (vendor,
-- keyword) are valid evidence of pricing drift.
DROP INDEX IF EXISTS uniq_vendor_pricing_vendor_keyword;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_vendor_pricing_active
  ON vendor_pricing_history(vendor_id, item_keyword)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_pricing_active
  ON vendor_pricing_history(vendor_id, created_at DESC)
  WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. briefing_cards — risk score version
-- ---------------------------------------------------------------------------
ALTER TABLE briefing_cards
  ADD COLUMN IF NOT EXISTS risk_score_version TEXT NOT NULL DEFAULT 'pr6-baseline';
