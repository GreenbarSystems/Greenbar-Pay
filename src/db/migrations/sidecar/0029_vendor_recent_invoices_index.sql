-- Vendor detail page "recent invoices" query (src/app/(app)/vendors/[id]/page.tsx):
--
--   SELECT id, invoice_number, invoice_date, total, review_status, document_id
--   FROM extracted_invoices
--   WHERE organization_id = $1
--     AND review_status IN ('approved', 'exported')
--     AND normalize_vendor_text(vendor_name) = $2
--   ORDER BY invoice_date DESC
--   LIMIT 10
--
-- idx_invoices_org_normalized_vendor (0022) covers the equality filter
-- (org, normalize_vendor_text(vendor_name), partial WHERE approved/
-- exported) but not the ORDER BY. At low invoice-per-vendor counts
-- Postgres just sorts the matched rows in memory; at 1M+ invoices for
-- a high-volume vendor that sort becomes the dominant cost.
--
-- Adding invoice_date DESC as a third key lets this exact query become
-- an index-range scan in the correct order with LIMIT 10 short-
-- circuiting after the first matching page — no sort node, no reading
-- rows past what's needed.
--
-- Separate index rather than modifying idx_invoices_org_normalized_vendor
-- (0022) because that index also serves recomputeVendorProfile's join
-- shape, which doesn't care about invoice_date ordering — adding an
-- extra key there would only bloat it for no benefit to that caller.
CREATE INDEX IF NOT EXISTS idx_ei_vendor_recent_invoices
  ON extracted_invoices (organization_id, normalize_vendor_text(vendor_name), invoice_date DESC)
  WHERE review_status IN ('approved', 'exported');
