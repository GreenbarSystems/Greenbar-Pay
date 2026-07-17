-- Phase: PO Matching (2-way / 3-way)
-- Three new tables: purchase_orders, purchase_order_lines, po_match_results.
-- All follow the same RLS + policy + index conventions as vendorContracts (0032).

-- ── purchase_orders ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS purchase_orders (
  id                   uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid           NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  client_id            uuid                    REFERENCES clients(id) ON DELETE RESTRICT,
  po_number            text           NOT NULL,
  vendor_id            uuid                    REFERENCES vendors(id) ON DELETE RESTRICT,
  vendor_name          text,
  issue_date           date,
  expiry_date          date,
  currency             text           NOT NULL DEFAULT 'USD',
  subtotal             numeric(14,2),
  tax                  numeric(14,2),
  shipping             numeric(14,2),
  total                numeric(14,2)  NOT NULL,
  status               text           NOT NULL DEFAULT 'open',
  receipt_confirmed_at timestamptz,
  receipt_confirmed_by uuid                    REFERENCES users(id) ON DELETE SET NULL,
  notes                text,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  updated_at           timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (organization_id, po_number)
);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;

CREATE POLICY purchase_orders_org_isolation ON purchase_orders
  USING (organization_id = app_current_org_id())
  WITH CHECK (organization_id = app_current_org_id());

CREATE INDEX IF NOT EXISTS idx_purchase_orders_org_status
  ON purchase_orders (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor_id
  ON purchase_orders (vendor_id)
  WHERE vendor_id IS NOT NULL;

-- ── purchase_order_lines ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid           NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  purchase_order_id uuid           NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_number       integer        NOT NULL,
  description       text           NOT NULL,
  item_keyword      text,
  quantity          numeric(14,4)  NOT NULL,
  unit_price        numeric(14,4)  NOT NULL,
  amount            numeric(14,2)  NOT NULL,
  received_quantity numeric(14,4),
  created_at        timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, line_number)
);

ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY purchase_order_lines_org_isolation ON purchase_order_lines
  USING (organization_id = app_current_org_id())
  WITH CHECK (organization_id = app_current_org_id());

CREATE INDEX IF NOT EXISTS idx_po_lines_po_id
  ON purchase_order_lines (purchase_order_id);

-- Mirrors idx_vendor_contract_lines_org_keyword — enables indexed keyword
-- lookup across all lines in the org without a per-PO scan.
CREATE INDEX IF NOT EXISTS idx_po_lines_org_keyword
  ON purchase_order_lines (organization_id, item_keyword)
  WHERE item_keyword IS NOT NULL;

-- ── po_match_results ─────────────────────────────────────────────────────────
-- Append-only (superseded_at pattern). The active row is the one with
-- superseded_at IS NULL. Partial unique index enforces at most one active
-- match result per invoice.

CREATE TABLE IF NOT EXISTS po_match_results (
  id                   uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid           NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  extracted_invoice_id uuid           NOT NULL REFERENCES extracted_invoices(id) ON DELETE RESTRICT,
  purchase_order_id    uuid                    REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  match_type           text,
  status               text           NOT NULL,
  invoice_total        numeric(14,2),
  po_total             numeric(14,2),
  variance_pct         numeric(7,4),
  line_variances_json  jsonb,
  matched_at           timestamptz    NOT NULL DEFAULT now(),
  superseded_at        timestamptz
);

ALTER TABLE po_match_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_match_results FORCE ROW LEVEL SECURITY;

CREATE POLICY po_match_results_org_isolation ON po_match_results
  USING (organization_id = app_current_org_id())
  WITH CHECK (organization_id = app_current_org_id());

-- One active match result per invoice (partial unique index mirrors
-- validation_results's same pattern).
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_match_results_active
  ON po_match_results (organization_id, extracted_invoice_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_po_match_results_invoice_id
  ON po_match_results (extracted_invoice_id);

-- Grant to app roles (same grants as every other table in this repo).
GRANT SELECT, INSERT, UPDATE ON purchase_orders TO app_user, app_worker;
GRANT SELECT, INSERT ON purchase_order_lines TO app_user, app_worker;
GRANT SELECT, INSERT, UPDATE ON po_match_results TO app_user, app_worker;
