-- Phase 7 — vendor memory layer (D1 from the updated MVP spec).
--
-- 1. Augment `vendors` with derived-stat columns and the aliases array.
-- 2. New `vendor_pricing_history` table + RLS.
-- 3. New match_method column on `vendor_matches` so the matcher can
--    record HOW it resolved (exact / alias / jaccard / null).
--
-- All ALTERs are IF NOT EXISTS to make the migration idempotent.

-- ---------------------------------------------------------------------------
-- 1. vendors — profile stats + aliases
-- ---------------------------------------------------------------------------
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS default_gl_code TEXT,
  ADD COLUMN IF NOT EXISTS invoice_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_invoice_date DATE,
  ADD COLUMN IF NOT EXISTS spend_30d NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spend_90d NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_invoice_amount NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duplicate_submission_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terms_drift_detected BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_profile_updated TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2. vendor_pricing_history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_pricing_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  item_keyword    TEXT NOT NULL,
  avg_unit_price  NUMERIC(16, 4) NOT NULL,
  samples         INTEGER NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_vendor_pricing_vendor_keyword
  ON vendor_pricing_history(vendor_id, item_keyword);

CREATE INDEX IF NOT EXISTS idx_vendor_pricing_vendor
  ON vendor_pricing_history(vendor_id);

ALTER TABLE vendor_pricing_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_pricing_history FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vendor_pricing_history;
CREATE POLICY tenant_isolation ON vendor_pricing_history
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- 3. vendor_matches — match_method column
-- ---------------------------------------------------------------------------
ALTER TABLE vendor_matches
  ADD COLUMN IF NOT EXISTS match_method TEXT;
