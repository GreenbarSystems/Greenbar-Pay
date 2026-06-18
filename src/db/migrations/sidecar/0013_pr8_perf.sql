-- PR8 — perf indexes from Phase 7+8 review.
--
-- 1. Functional index on extracted_invoices.(org, normalize_vendor_text(vendor_name)).
--    The briefing prior-invoice join (src/jobs/generateBriefingCard.ts) and the
--    recompute join (src/jobs/recomputeVendorProfile.ts, two callsites) both
--    use `normalize_vendor_text(extracted_invoices.vendor_name) = …`. Without a
--    functional index every approval triggers a seqscan over extracted_invoices.
--    The function is IMMUTABLE (declared in 0011_pr5_phase7_hotfix.sql) so the
--    expression can be indexed.
--
-- 2. Composite index on vendors(organization_id, invoice_count DESC, last_invoice_date DESC).
--    /vendors list orders by (invoice_count DESC, last_invoice_date DESC) within
--    an org. The existing idx_vendors_org seeks the org range but the planner
--    still needs an in-memory sort.

-- ---------------------------------------------------------------------------
-- 1. Functional index for the vendor-normalize join.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ei_org_norm_vendor_name
  ON extracted_invoices(organization_id, normalize_vendor_text(vendor_name));

-- ---------------------------------------------------------------------------
-- 2. Vendor-list sort index.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_vendors_org_count_lastinv
  ON vendors(organization_id, invoice_count DESC, last_invoice_date DESC);
