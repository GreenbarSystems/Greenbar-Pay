-- PR18 — pre-pilot critical fixes from the consolidated adversarial pass.
--
-- 1. audit_events DB-level append-only RULES.
--    The table is the system of record for every other control;
--    leaving it application-only enforcement means a single admin
--    session could rewrite history. PR15 added these for
--    evidence_packets and invoice_override_log; this extends the same
--    treatment to audit_events itself. Combined with the
--    ON DELETE CASCADE → RESTRICT change below, the audit chain is
--    durable against both UPDATE/DELETE and parent cascade.
--
-- 2. audit_events.organizationId ON DELETE CASCADE → RESTRICT.
--    Deleting an organisation (e.g. pilot off-boarding) silently
--    destroyed the entire audit history for that org. The RESTRICT
--    version forces an operator to make an explicit choice (typically
--    archive then delete) rather than wiping the trail accidentally.

-- ── 1. Append-only RULES on audit_events ──────────────────────────
-- DO INSTEAD NOTHING is the same pattern PR15 used for the other
-- attestation tables. It silently no-ops application-layer UPDATE/
-- DELETE attempts; combined with revoking those grants from app_user
-- and app_worker (already in 0001_rls.sql for everything except
-- app_admin), bypass requires deliberate DBA action via app_admin.
DROP RULE IF EXISTS audit_events_no_update ON audit_events;
DROP RULE IF EXISTS audit_events_no_delete ON audit_events;
CREATE RULE audit_events_no_update AS ON UPDATE TO audit_events DO INSTEAD NOTHING;
CREATE RULE audit_events_no_delete AS ON DELETE TO audit_events DO INSTEAD NOTHING;

-- ── 2. audit_events.organizationId FK → RESTRICT ──────────────────
ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS audit_events_organization_id_fkey;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
