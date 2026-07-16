-- Multi-step approval workflows + multi-client un-freeze (2026-07-16)
--
-- 1. Extend invoice_review_status with 'pending_final_approval'
--    (invoices awaiting stage-2 admin sign-off in 2-stage orgs)
-- 2. Add approval_stages_required to organizations (default 1)
-- 3. New table: invoice_approval_actions — per-stage audit trail
--
-- IF NOT EXISTS / ADD VALUE IF NOT EXISTS keep the migration idempotent
-- on any environment that partially applied it.

-- 1. Enum extension
ALTER TYPE invoice_review_status ADD VALUE IF NOT EXISTS 'pending_final_approval' AFTER 'needs_review';

-- 2. Organizations — approval stage count
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS approval_stages_required integer NOT NULL DEFAULT 1;

-- 3. Approval actions table
CREATE TABLE IF NOT EXISTS invoice_approval_actions (
  id                    uuid                        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id       uuid                        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  extracted_invoice_id  uuid                        NOT NULL REFERENCES extracted_invoices (id) ON DELETE CASCADE,
  stage_order           integer                     NOT NULL,
  actor_id              uuid                        NOT NULL REFERENCES users (id),
  action                text                        NOT NULL,
  note                  text,
  created_at            timestamptz                 NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_approval_actions_invoice
  ON invoice_approval_actions (extracted_invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoice_approval_actions_org
  ON invoice_approval_actions (organization_id);

-- RLS
ALTER TABLE invoice_approval_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_approval_actions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'invoice_approval_actions'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON invoice_approval_actions
      USING (organization_id = app_current_org_id())
      WITH CHECK (organization_id = app_current_org_id());
  END IF;
END $$;

GRANT SELECT, INSERT ON invoice_approval_actions TO app_user;
GRANT SELECT, INSERT ON invoice_approval_actions TO app_worker;
