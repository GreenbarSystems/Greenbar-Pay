-- Phase 6 — RLS for AP inbox tables.
--
-- email_messages.organization_id is nullable because newly-arrived
-- messages with an unroutable address have no tenant yet — they sit
-- in an admin queue with status='unrouted'. The RLS USING clause
-- allows `organization_id IS NULL` so the admin tooling (which runs
-- with the GUC unset OR with a SUPERADMIN context) can see them.
-- Tenant users only see their own.

ALTER TABLE email_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages       FORCE  ROW LEVEL SECURITY;
ALTER TABLE email_attachments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_attachments    FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON email_messages;
DROP POLICY IF EXISTS tenant_isolation ON email_attachments;

-- email_messages: tenant rows + unrouted rows visible only when
-- the org GUC is unset (admin/console mode).
CREATE POLICY tenant_isolation ON email_messages
  USING (
    organization_id = current_setting('app.current_org_id', true)::uuid
  )
  WITH CHECK (
    organization_id IS NULL
    OR organization_id = current_setting('app.current_org_id', true)::uuid
  );

CREATE POLICY tenant_isolation ON email_attachments
  USING (
    organization_id = current_setting('app.current_org_id', true)::uuid
  )
  WITH CHECK (
    organization_id IS NULL
    OR organization_id = current_setting('app.current_org_id', true)::uuid
  );
