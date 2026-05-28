-- Addendum §1.2 — Row-Level Security on every tenant-scoped table.
-- Authoritative tenant isolation: a bug in the app cannot leak data across orgs.
-- Connection state carries the current org via app.current_org_id (a session GUC).

-- ---------------------------------------------------------------------------
-- Roles (§1.3)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker LOGIN PASSWORD 'app_worker_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin LOGIN PASSWORD 'app_admin_pw' BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user, app_worker, app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO app_user, app_worker, app_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO app_user, app_worker, app_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO app_user, app_worker, app_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, app_worker, app_admin;

-- ---------------------------------------------------------------------------
-- Tenant policy template
-- ---------------------------------------------------------------------------
-- current_setting(..., true) returns NULL when unset → the USING clause yields
-- NULL → no rows visible. That's the safe default: a query made without
-- SET LOCAL app.current_org_id sees nothing.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'organizations',
    'users',
    'clients',
    'user_client_access',
    'documents',
    'audit_events',
    'api_idempotency_keys'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
  END LOOP;
END
$$;

-- organizations: row id IS the tenant id.
CREATE POLICY tenant_isolation ON organizations
  USING      (id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_org_id', true)::uuid);

-- All other tenant tables key on organization_id directly.
CREATE POLICY tenant_isolation ON users
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY tenant_isolation ON clients
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

-- user_client_access has no org column; scope via the parent client.
CREATE POLICY tenant_isolation ON user_client_access
  USING (
    EXISTS (
      SELECT 1 FROM clients c
      WHERE c.id = user_client_access.client_id
        AND c.organization_id = current_setting('app.current_org_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM clients c
      WHERE c.id = user_client_access.client_id
        AND c.organization_id = current_setting('app.current_org_id', true)::uuid
    )
  );

CREATE POLICY tenant_isolation ON documents
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY tenant_isolation ON audit_events
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY tenant_isolation ON api_idempotency_keys
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
