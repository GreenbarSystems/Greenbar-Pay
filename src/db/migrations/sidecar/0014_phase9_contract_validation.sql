-- Phase 9 — Contract Validation (D3) + F06 Line-Item Confidence + F07 Evidence Chain.
--
-- Three additions, no new tables:
--
-- 1. vendor_pricing_history gets the missing statistical fields.
--    The table is named "history" but acts as the per-keyword stats
--    snapshot — one active row per (vendor, keyword) with the running
--    aggregate computed by recomputeVendorProfile. We add stddev, min,
--    max, last_unit_price, and price_trend so the rate-drift validator
--    can score deviations in standard deviations, not just absolute %.
--    All columns nullable: existing rows pre-Phase-9 don't have the
--    underlying samples needed to backfill, and the rule treats NULL
--    stddev as "insufficient data" → no drift finding.
--
-- 2. extracted_invoice_lines gets F06 line-item confidence columns.
--    Populated by validateExtractedInvoice when it scores each line
--    against the vendor's pricing stats. confidence_score is a TEXT
--    enum-ish (CHECK constraint) over high/medium/low/new. NULL means
--    the line was never scored (legacy row, or no vendor matched).
--
-- 3. briefing_cards.anomaly_flags_json gains an optional `evidence_chain`
--    array per flag (F07). No DDL change — anomaly_flags_json is already
--    jsonb. The Zod schema and LLM prompt enforce shape.

-- ---------------------------------------------------------------------------
-- 1. vendor_pricing_history stats columns
-- ---------------------------------------------------------------------------
ALTER TABLE vendor_pricing_history
  ADD COLUMN IF NOT EXISTS stddev_unit_price NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS min_unit_price    NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS max_unit_price    NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS last_unit_price   NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS price_trend       TEXT
    CHECK (price_trend IS NULL OR price_trend IN (
      'stable',
      'rising',
      'falling',
      'insufficient_data'
    ));

-- ---------------------------------------------------------------------------
-- 2. extracted_invoice_lines confidence scoring columns
-- ---------------------------------------------------------------------------
ALTER TABLE extracted_invoice_lines
  ADD COLUMN IF NOT EXISTS confidence_score TEXT
    CHECK (confidence_score IS NULL OR confidence_score IN (
      'high', 'medium', 'low', 'new'
    )),
  ADD COLUMN IF NOT EXISTS confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS hist_sample_count INTEGER,
  ADD COLUMN IF NOT EXISTS hist_avg_price    NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS hist_stddev_price NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS stddev_distance   NUMERIC(7, 2);
