-- Phase 11 — Audit-Ready Evidence Packet (D4) + Stop Work Authority (F02).
--
-- 1. evidence_packets — one immutable row per approved invoice.
--    Assembled by the post-approval pg-boss job from the pinned
--    artifacts (briefing, validation, vendor profile, llm run,
--    approve audit event). The manifest is the canonical JSON
--    payload; manifest_hash is a sha256 over a deterministic
--    serialisation so an auditor can re-verify any time.
--    pdf_storage_key + pdf_generated_at are nullable — Phase 11
--    ships JSON only; PDF rendering is a follow-up phase. Append-
--    only: NEVER updated; the UNIQUE (extracted_invoice_id)
--    constraint makes re-assembly fail loudly rather than
--    silently overwrite.
--
-- 2. invoice_override_log — Stop Work Authority records. When an
--    approver chooses to push through despite blocking validation
--    findings, the override and its justification land here.
--    Append-only (DO INSTEAD NOTHING on UPDATE/DELETE) so the
--    decision can never be retroactively rewritten.

-- ── 1. evidence_packets ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS evidence_packets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  extracted_invoice_id  UUID NOT NULL REFERENCES extracted_invoices(id) ON DELETE CASCADE,
  document_id           UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sealed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  sealed_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  /** SHA-256 over the canonical JSON serialisation of manifest_json. */
  manifest_hash         TEXT NOT NULL,
  /** The full audit-ready payload (full extracted invoice, validation,
   *  vendor profile snapshot, briefing card, approver action log). */
  manifest_json         JSONB NOT NULL,
  /** Re-verified copy of documents.content_hash at seal time. Lets the
   *  evidence packet stand alone — verifying the source file's
   *  identity doesn't require trusting `documents.content_hash` to
   *  not be mutated. */
  source_document_hash  TEXT NOT NULL,
  /** NULL until a PDF render job lands. Phase 11 ships JSON only. */
  pdf_storage_key       TEXT,
  pdf_generated_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_evidence_packet_per_invoice
    UNIQUE (organization_id, extracted_invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_packets_org_sealed
  ON evidence_packets(organization_id, sealed_at DESC);

ALTER TABLE evidence_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_packets FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON evidence_packets;
CREATE POLICY tenant_isolation ON evidence_packets
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Append-only: no UPDATE, no DELETE. Evidence packets are immutable
-- attestations — they can be re-assembled (insert new with a different
-- hash) only by deleting the row first, which is itself disallowed.
CREATE RULE evidence_packets_no_update AS ON UPDATE TO evidence_packets DO INSTEAD NOTHING;
CREATE RULE evidence_packets_no_delete AS ON DELETE TO evidence_packets DO INSTEAD NOTHING;

-- ── 2. invoice_override_log ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_override_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  extracted_invoice_id     UUID NOT NULL REFERENCES extracted_invoices(id) ON DELETE CASCADE,
  document_id              UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  overriding_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  /** Optional. F02 spec wants this populated above an org-configured
   *  override threshold; the MVP collects it when present but does not
   *  yet enforce a min-amount policy. */
  second_approver_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  /** Human-typed justification. The CHECK keeps the floor enforced at
   *  the DB layer so a misbehaving caller can't bypass with an empty
   *  string. */
  justification_text       TEXT NOT NULL
    CHECK (char_length(justification_text) >= 20),
  override_amount          NUMERIC(14, 2),
  /** Snapshot of the blocking finding codes that were overridden, so
   *  an auditor can read "what exactly was waived" without joining to
   *  the validation_results row at decision time. */
  blocking_finding_codes   JSONB NOT NULL DEFAULT '[]'::jsonb,
  ip_address               INET,
  user_agent               TEXT,
  approved_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_override_log_org_approved
  ON invoice_override_log(organization_id, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_override_log_invoice
  ON invoice_override_log(organization_id, extracted_invoice_id);

ALTER TABLE invoice_override_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_override_log FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON invoice_override_log;
CREATE POLICY tenant_isolation ON invoice_override_log
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE RULE override_log_no_update AS ON UPDATE TO invoice_override_log DO INSTEAD NOTHING;
CREATE RULE override_log_no_delete AS ON DELETE TO invoice_override_log DO INSTEAD NOTHING;
