-- Accounting integration support: QBO + Xero OAuth connections,
-- per-item external IDs on export_items, and new export_format values.

-- 1. New export_format enum values (must be outside a transaction in PG < 14).
ALTER TYPE export_format ADD VALUE IF NOT EXISTS 'qbo';
ALTER TYPE export_format ADD VALUE IF NOT EXISTS 'xero';

-- 2. External sync ID on export_items (QBO Bill ID / Xero Invoice ID).
ALTER TABLE export_items ADD COLUMN IF NOT EXISTS external_id text;

-- 3. Accounting connections table.
CREATE TABLE IF NOT EXISTS accounting_connections (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider          text        NOT NULL,           -- 'qbo' | 'xero'
  realm_id          text        NOT NULL,           -- QBO realmId / Xero tenantId
  access_token      text        NOT NULL,           -- AES-256-GCM encrypted
  refresh_token     text        NOT NULL,           -- AES-256-GCM encrypted
  token_expires_at  timestamptz NOT NULL,
  settings          jsonb       NOT NULL DEFAULT '{}',
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_accounting_connections_org_provider UNIQUE (organization_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_accounting_connections_org
  ON accounting_connections (organization_id);

-- RLS: each org can only see its own connection rows.
ALTER TABLE accounting_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_connections_org ON accounting_connections
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);
