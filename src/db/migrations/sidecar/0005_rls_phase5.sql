-- Phase 5 — RLS for the export tables.

ALTER TABLE exports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports       FORCE  ROW LEVEL SECURITY;
ALTER TABLE export_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_items  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON exports;
DROP POLICY IF EXISTS tenant_isolation ON export_items;

CREATE POLICY tenant_isolation ON exports
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY tenant_isolation ON export_items
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
