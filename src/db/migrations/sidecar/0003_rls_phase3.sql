-- Phase 3 — extend RLS to the LLM gateway tables and add the §4.2
-- supersede pattern's partial unique index.

ALTER TABLE llm_runs                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_runs                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE extracted_invoices        ENABLE ROW LEVEL SECURITY;
ALTER TABLE extracted_invoices        FORCE  ROW LEVEL SECURITY;
ALTER TABLE extracted_invoice_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE extracted_invoice_lines   FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON llm_runs;
DROP POLICY IF EXISTS tenant_isolation ON extracted_invoices;
DROP POLICY IF EXISTS tenant_isolation ON extracted_invoice_lines;

CREATE POLICY tenant_isolation ON llm_runs
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY tenant_isolation ON extracted_invoices
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY tenant_isolation ON extracted_invoice_lines
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Addendum §4.2 — at most ONE active (pending|needs_review) invoice row
-- per document. Approved/rejected/exported rows are outside the index
-- and immune to supersede.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_extracted_invoices_active
  ON extracted_invoices(document_id)
  WHERE review_status IN ('pending', 'needs_review');
