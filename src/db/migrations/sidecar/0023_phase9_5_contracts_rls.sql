-- Phase 9.5 — Contract Document Parser (D3 second half).
-- Add RLS + extra constraints on the two new tables.

-- ── RLS — same pattern as every other tenant-scoped table. ─────────
-- The 0021 helper app_current_org_id() returns NULL on unset GUC so
-- the policies survive a query made outside withOrg.
ALTER TABLE vendor_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_contracts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vendor_contracts;
CREATE POLICY tenant_isolation ON vendor_contracts
  USING      (organization_id = app_current_org_id())
  WITH CHECK (organization_id = app_current_org_id());

ALTER TABLE vendor_contract_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_contract_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vendor_contract_lines;
CREATE POLICY tenant_isolation ON vendor_contract_lines
  USING      (organization_id = app_current_org_id())
  WITH CHECK (organization_id = app_current_org_id());

-- ── Single-active-contract guard. ─────────────────────────────────
-- A vendor can have at most one 'active' contract at a time. Past
-- contracts move to 'superseded' via supersededAt; new uploads land
-- in 'extracted' until an admin activates them. The partial unique
-- index enforces the invariant at the DB layer so a UI race can't
-- create two active contracts for the same vendor.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_vendor_contracts_active_per_vendor
  ON vendor_contracts (organization_id, vendor_id)
  WHERE status = 'active' AND vendor_id IS NOT NULL;

-- ── Useful read index for the future validation rule. ─────────────
-- A `(org, item_keyword)` lookup against ACTIVE contract lines is
-- the hot path: "what's the contracted rate for keyword X right now
-- in this org?" A partial index keeps the working set tiny.
CREATE INDEX IF NOT EXISTS idx_vendor_contract_lines_active_keyword
  ON vendor_contract_lines (organization_id, item_keyword)
  WHERE item_keyword IS NOT NULL;
