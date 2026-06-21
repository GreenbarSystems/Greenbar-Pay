-- Issue #3 — RLS policies must tolerate an unset GUC.
--
-- The original tenant_isolation policies (since sidecar 0001) compare
-- against `current_setting('app.current_org_id', true)::uuid`. The
-- `true` second arg returns '' when the GUC is unset, and ''::uuid
-- throws "invalid input syntax for type uuid". The rls.test.ts case
-- "unset GUC → no rows visible (safe default)" hits this path
-- because the test deliberately leaves the GUC unset.
--
-- Fix: replace the cast with a helper function that returns NULL on
-- empty / unset. A comparison `id = NULL` is NULL (filtered as false),
-- preserving the "no rows visible" invariant without throwing.

-- ── 1. Helper function ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_current_org_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$
    SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
  $$;

-- ── 2. Recreate every tenant_isolation policy ──────────────────────
-- Two shapes:
--   · organizations — keyed on its own id
--   · user_client_access — keyed via a clients lookup (no org column)
--   · everything else — keyed on organization_id directly
DO $$
DECLARE
  t text;
  org_keyed_tables text[] := ARRAY[
    'users',
    'clients',
    'documents',
    'audit_events',
    'api_idempotency_keys',
    'document_extractions',
    'llm_runs',
    'extracted_invoices',
    'extracted_invoice_lines',
    'briefing_cards',
    'vendors',
    'vendor_matches',
    'vendor_pricing_history',
    'validation_results',
    'exports',
    'export_items',
    'email_messages',
    'email_attachments',
    'evidence_packets',
    'invoice_override_log'
  ];
BEGIN
  -- organizations: row id IS the tenant id.
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON organizations';
  EXECUTE
    'CREATE POLICY tenant_isolation ON organizations '
    'USING (id = app_current_org_id()) '
    'WITH CHECK (id = app_current_org_id())';

  -- user_client_access: no org column; scope via parent client.
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON user_client_access';
  EXECUTE
    'CREATE POLICY tenant_isolation ON user_client_access '
    'USING (EXISTS (SELECT 1 FROM clients c WHERE c.id = user_client_access.client_id '
    '               AND c.organization_id = app_current_org_id())) '
    'WITH CHECK (EXISTS (SELECT 1 FROM clients c WHERE c.id = user_client_access.client_id '
    '                    AND c.organization_id = app_current_org_id()))';

  -- All other tenant tables: organization_id = current org.
  FOREACH t IN ARRAY org_keyed_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (organization_id = app_current_org_id()) '
      'WITH CHECK (organization_id = app_current_org_id())',
      t
    );
  END LOOP;
END
$$;
