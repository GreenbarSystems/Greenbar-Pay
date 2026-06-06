-- Phase 4 — RLS for vendor + validation tables.

ALTER TABLE vendors             ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors             FORCE  ROW LEVEL SECURITY;
ALTER TABLE vendor_matches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_matches      FORCE  ROW LEVEL SECURITY;
ALTER TABLE validation_results  ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_results  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON vendors;
DROP POLICY IF EXISTS tenant_isolation ON vendor_matches;
DROP POLICY IF EXISTS tenant_isolation ON validation_results;

CREATE POLICY tenant_isolation ON vendors
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY tenant_isolation ON vendor_matches
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY tenant_isolation ON validation_results
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
