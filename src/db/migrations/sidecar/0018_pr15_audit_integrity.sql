-- PR15 — audit + evidence integrity from the Phase 10/11 review.
--
-- 1. FK cascade bypass on the immutability RULES.
--    Phase 11 declared evidence_packets and invoice_override_log
--    append-only via `DO INSTEAD NOTHING` RULES, but FK cascade
--    deletes operate at a lower level than user RULES — deleting a
--    parent organisation, invoice, or document silently removed
--    evidence rows with no audit trail. Switch the cascade targets
--    to RESTRICT so a parent delete is rejected unless the child is
--    already gone (and an audit trail can record the operator
--    action that touched the row). The RULES still guard against
--    application-layer DELETE statements.
--
-- 2. audit_events sequence column.
--    PR12 added attestation chain metadata; the Phase 11 review then
--    flagged that audit_events rows written inside the same
--    transaction share `created_at = now()` to the millisecond, so
--    auditor queries `ORDER BY created_at` cannot prove that
--    invoice.override_recorded preceded invoice.approved. A bigserial
--    column tie-breaks: same created_at, monotonically-increasing
--    seq, ordering becomes deterministic.
--
-- Issue #3 fix: the original DROP CONSTRAINT IF EXISTS lines used
-- Postgres-default constraint names (`evidence_packets_*_fkey`), but
-- drizzle-kit init.sql names FKs `<table>_<col>_<reftable>_<refcol>_fk`.
-- IF EXISTS made the drops silent no-ops, so the CASCADE FKs stayed
-- and the `no_delete` RULES then conflicted with internal FK trigger
-- queries. Look up actual FK names from pg_constraint and drop those.

-- ── 1. FK cascade → RESTRICT ───────────────────────────────────────
-- Drop whatever FK constraints currently exist on the relevant columns
-- (drizzle-generated or Postgres-default), then re-add the RESTRICT
-- versions under canonical names.
DO $$
DECLARE
  c text;
BEGIN
  -- evidence_packets
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'evidence_packets'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE evidence_packets DROP CONSTRAINT %I', c);
  END LOOP;
  -- invoice_override_log
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'invoice_override_log'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE invoice_override_log DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE evidence_packets
  ADD CONSTRAINT evidence_packets_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT evidence_packets_extracted_invoice_id_fkey
    FOREIGN KEY (extracted_invoice_id) REFERENCES extracted_invoices(id) ON DELETE RESTRICT,
  ADD CONSTRAINT evidence_packets_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE RESTRICT,
  ADD CONSTRAINT evidence_packets_sealed_by_user_id_fkey
    FOREIGN KEY (sealed_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE invoice_override_log
  ADD CONSTRAINT invoice_override_log_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT invoice_override_log_extracted_invoice_id_fkey
    FOREIGN KEY (extracted_invoice_id) REFERENCES extracted_invoices(id) ON DELETE RESTRICT,
  ADD CONSTRAINT invoice_override_log_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE RESTRICT,
  ADD CONSTRAINT invoice_override_log_overriding_user_id_fkey
    FOREIGN KEY (overriding_user_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT invoice_override_log_second_approver_id_fkey
    FOREIGN KEY (second_approver_id) REFERENCES users(id) ON DELETE SET NULL;

-- ── 2. audit_events.seq ────────────────────────────────────────────
-- Backfilled in row-insert order by the implicit oid sequence. Reads
-- that ORDER BY (created_at, seq) get a deterministic timeline.
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

CREATE INDEX IF NOT EXISTS idx_audit_events_entity_seq
  ON audit_events(entity_type, entity_id, created_at, seq);
