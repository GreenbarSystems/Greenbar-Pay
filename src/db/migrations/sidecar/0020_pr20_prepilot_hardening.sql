-- PR20 — pre-pilot hardening from the consolidated adversarial pass.
--
-- 1. documents(organization_id, received_at DESC).
--    The review queue page filters on `(organization_id,
--    reviewStatus)` via idx_extracted_invoices_org_review_status and
--    sorts by documents.received_at DESC after the join. The sort
--    falls back to a filesort until ~1k rows; this index gets the
--    planner to use an indexed scan path even after the join.
--
-- 2. extracted_invoices(organization_id, vendor_name) — for the
--    vendor detail page's "Recent approved invoices" lookup. The
--    page is migrating to the normalize_vendor_text functional
--    index in this PR, but the raw vendor_name index is a fallback
--    for any path that hasn't migrated yet.
--
-- 3. api_idempotency_keys cleanup index. PR19 added the TTL
--    predicate; the read path now includes `created_at > now() -
--    interval '24 hours'`. The existing createdAt index already
--    serves this query.

CREATE INDEX IF NOT EXISTS idx_documents_org_received
  ON documents(organization_id, received_at DESC);
