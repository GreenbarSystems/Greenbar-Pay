-- PR13 — Phase 9 perf opt-ins.
--
-- recomputeVendorProfile runs once per approve and joins extracted_
-- invoices to vendors via the expression
--   normalize_vendor_text(extracted_invoices.vendor_name)
-- = vendors.normalized_name (or `= ANY(aliases)`). The expression-
-- side index `idx_vendors_normalized_name` accelerates the vendor
-- side of the join, but the invoice side has nothing — so on every
-- approve Postgres evaluates `normalize_vendor_text()` once per
-- invoice in the entire org.
--
-- At a vendor-stats-relevant subset (review_status IN approved,
-- exported), a partial functional index lets the planner do a
-- bitmap scan instead of a full table scan. The cost is a small
-- amount of write overhead on approve (one btree insert) — vastly
-- cheaper than the recompute's read amplification at scale.
--
-- The supporting query (the second filter, on ALL statuses) is
-- subsumed by PR13's JS-side split; we no longer issue a second
-- scan for the duplicate-pattern count.

CREATE INDEX IF NOT EXISTS idx_invoices_org_normalized_vendor
  ON extracted_invoices (organization_id, normalize_vendor_text(vendor_name))
  WHERE review_status IN ('approved', 'exported');

-- The unfiltered counterpart, used for the duplicate-pattern lookup
-- when the JS split walks the whole vendor history. Cheaper than a
-- full scan because the planner can intersect with the org filter.
CREATE INDEX IF NOT EXISTS idx_invoices_org_normalized_vendor_all
  ON extracted_invoices (organization_id, normalize_vendor_text(vendor_name));
