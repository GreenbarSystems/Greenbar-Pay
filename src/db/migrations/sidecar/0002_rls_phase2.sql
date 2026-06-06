-- Phase 2 — extend RLS to document_extractions and any other tenant-scoped
-- tables introduced in this phase. Same pattern as 0001_rls.sql.

ALTER TABLE document_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extractions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON document_extractions;

CREATE POLICY tenant_isolation ON document_extractions
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Grant the pg-boss schema (created on first boss.start()) to all app roles.
-- pg-boss runs its own tables under `pgboss` and does its own locking — it
-- does not need RLS. The role grants are idempotent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    GRANT USAGE ON SCHEMA pgboss TO app_user, app_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss
      TO app_user, app_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss
      TO app_user, app_worker;
  END IF;
END
$$;
