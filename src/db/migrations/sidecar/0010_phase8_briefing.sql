-- Phase 8 — Briefing Card (D2 from updated MVP spec).
--
-- briefing_cards: append-only with superseded_at (same pattern as
-- validation_results in PR2). Active view is WHERE superseded_at IS NULL.

CREATE TABLE IF NOT EXISTS briefing_cards (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  extracted_invoice_id  UUID NOT NULL REFERENCES extracted_invoices(id) ON DELETE CASCADE,
  llm_run_id            UUID REFERENCES llm_runs(id) ON DELETE SET NULL,
  gl_code               TEXT,
  gl_rationale          TEXT NOT NULL,
  anomaly_flags_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
  delta_summary         TEXT NOT NULL DEFAULT '',
  risk_score            INTEGER NOT NULL,
  risk_justification    TEXT NOT NULL,
  vendor_context_json   JSONB,
  risk_factors_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_briefing_cards_invoice_active
  ON briefing_cards(extracted_invoice_id, created_at DESC)
  WHERE superseded_at IS NULL;

ALTER TABLE briefing_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE briefing_cards FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON briefing_cards;
CREATE POLICY tenant_isolation ON briefing_cards
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
