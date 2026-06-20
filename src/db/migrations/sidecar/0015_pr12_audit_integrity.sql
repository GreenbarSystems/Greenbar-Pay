-- PR12 — audit completeness + evidence integrity from Phase 9 review.
--
-- 1. extracted_invoice_lines gets `updated_at` so the per-line
--    confidence record carries a timestamp. Without it, the
--    revalidation UPDATE in runValidationInTx is timestamp-blind —
--    an auditor cannot tell when a line's confidence_score was last
--    written. NULL on existing rows (no backfill clock available);
--    backfill writes via the standard sql`now()` from the next
--    revalidation onward.

ALTER TABLE extracted_invoice_lines
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
