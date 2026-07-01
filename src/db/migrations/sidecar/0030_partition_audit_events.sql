-- Partition audit_events by RANGE(created_at), monthly.
--
-- Why: audit_events is a hot-write, append-only table (every mutation,
-- approval, rejection, and export lands a row) with no bound on
-- retention (7-year regulatory hold per the addendum). At meaningful
-- pilot scale this becomes millions of rows/year in a single heap,
-- and time-range-scoped queries (dashboards, "activity in the last
-- 30 days", eventual archival tooling) degrade to full-table scans
-- with no way to cheaply drop old data short of a DELETE (which the
-- append-only RULES below block anyway).
--
-- Design:
--   - RANGE partition on created_at, one partition per calendar month.
--   - Composite PRIMARY KEY (id, created_at): Postgres requires the
--     partition key to be part of any PK/UNIQUE constraint on a
--     partitioned table. `id` alone can no longer be enforced unique
--     by a single index spanning all partitions, but it's a random
--     UUID (gen_random_uuid()) — practical collision risk is the same
--     astronomically small odds any UUID collision already carries.
--     No code in this repo does eq(auditEvents.id, x) as a write
--     target (RULES block UPDATE/DELETE entirely); the one read-side
--     usage (vendor detail page activity list) is a SELECT projection,
--     unaffected.
--   - A DEFAULT partition catches all pre-existing historical rows
--     (and anything that ever falls outside the explicitly-created
--     monthly range, as a safety net against the partition-maintenance
--     job ever falling behind). Postgres automatically migrates rows
--     out of DEFAULT into a new explicit partition when one is created
--     that overlaps existing DEFAULT contents — so backfilling current-
--     month data into its own partition happens for free below, with
--     no manual data-move step.
--   - RLS, the append-only RULES, and grants are defined on the
--     partitioned PARENT, which is sufficient for 100% of real traffic
--     (nothing in this codebase ever references a partition by name —
--     Drizzle only ever queries `audit_events`, and PostgreSQL rule
--     rewriting + RLS enforcement both act on the named relation in
--     the query BEFORE partition routing happens). As defense-in-depth
--     against a hypothetical direct-partition-name query (e.g. a
--     manual psql session), create_audit_events_partition() below ALSO
--     enables + forces RLS and creates the same policy on every
--     partition it creates, matching this repo's general append-only
--     "authoritative at the DB layer, redundant checks are cheap
--     insurance" philosophy.
--
-- Migration strategy: build the partitioned table under a temporary
-- name, copy all existing rows in, then rename-swap. This blocks
-- writes to audit_events for the duration of the copy — acceptable at
-- current (pre-pilot) data volume. The OLD table is renamed to
-- audit_events_pre_partition_backup rather than dropped; an operator
-- should verify the new table looks right in production, THEN drop
-- the backup in a follow-up migration once satisfied. See CLAUDE.md
-- for the operational note on when it's safe to drop.

-- ── 1. Build the partitioned replacement table ─────────────────────
DO $$
DECLARE
  seq_name text := pg_get_serial_sequence('audit_events', 'seq');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS audit_events_partitioned ('
    '  id uuid NOT NULL DEFAULT gen_random_uuid(),'
    '  organization_id uuid NOT NULL,'
    '  actor_type text NOT NULL,'
    '  actor_id uuid,'
    '  action text NOT NULL,'
    '  entity_type text NOT NULL,'
    '  entity_id uuid NOT NULL,'
    '  before_json jsonb,'
    '  after_json jsonb,'
    '  metadata_json jsonb NOT NULL DEFAULT ''{}''::jsonb,'
    '  created_at timestamptz NOT NULL DEFAULT now(),'
    '  seq bigint NOT NULL DEFAULT nextval(%L::regclass),'
    '  PRIMARY KEY (id, created_at)'
    ') PARTITION BY RANGE (created_at)',
    seq_name
  );
END $$;

-- FK to organizations, mirroring 0019's RESTRICT hardening (a parent
-- org delete must not silently wipe its audit trail).
ALTER TABLE audit_events_partitioned
  ADD CONSTRAINT audit_events_partitioned_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

-- Rename the OLD table's indexes out of the way so the new table can
-- take the canonical names below without a collision (index names are
-- schema-global-unique in Postgres; renaming a TABLE does not rename
-- its indexes).
ALTER INDEX IF EXISTS idx_audit_events_entity
  RENAME TO idx_audit_events_entity_pre_partition_backup;
ALTER INDEX IF EXISTS idx_audit_events_entity_seq
  RENAME TO idx_audit_events_entity_seq_pre_partition_backup;

CREATE INDEX idx_audit_events_entity
  ON audit_events_partitioned (entity_type, entity_id);
CREATE INDEX idx_audit_events_entity_seq
  ON audit_events_partitioned (entity_type, entity_id, created_at, seq);

-- RLS — authoritative for all traffic issued against the parent name.
ALTER TABLE audit_events_partitioned ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events_partitioned FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_events_partitioned;
CREATE POLICY tenant_isolation ON audit_events_partitioned
  USING      (organization_id = app_current_org_id())
  WITH CHECK (organization_id = app_current_org_id());

-- Append-only RULES — DO INSTEAD NOTHING intercepts UPDATE/DELETE
-- issued against the named relation `audit_events` before partition
-- routing occurs, matching the protection the non-partitioned table
-- had from migration 0019.
DROP RULE IF EXISTS audit_events_partitioned_no_update ON audit_events_partitioned;
DROP RULE IF EXISTS audit_events_partitioned_no_delete ON audit_events_partitioned;
CREATE RULE audit_events_partitioned_no_update AS ON UPDATE TO audit_events_partitioned DO INSTEAD NOTHING;
CREATE RULE audit_events_partitioned_no_delete AS ON DELETE TO audit_events_partitioned DO INSTEAD NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_events_partitioned TO app_user, app_worker, app_admin;

-- ── 2. DEFAULT partition — catches all historical data on copy ─────
CREATE TABLE IF NOT EXISTS audit_events_default
  PARTITION OF audit_events_partitioned DEFAULT;
ALTER TABLE audit_events_default ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events_default FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_events_default;
CREATE POLICY tenant_isolation ON audit_events_default
  USING      (organization_id = app_current_org_id())
  WITH CHECK (organization_id = app_current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_events_default TO app_user, app_worker, app_admin;

-- ── 3. Copy existing rows ───────────────────────────────────────────
-- Everything lands in audit_events_default for now; step 6 below
-- creates explicit monthly partitions for the current month + a
-- buffer, and Postgres automatically moves any matching rows out of
-- DEFAULT into those new partitions as part of creating them.
INSERT INTO audit_events_partitioned
  (id, organization_id, actor_type, actor_id, action, entity_type,
   entity_id, before_json, after_json, metadata_json, created_at, seq)
SELECT
  id, organization_id, actor_type, actor_id, action, entity_type,
  entity_id, before_json, after_json, metadata_json, created_at, seq
FROM audit_events;

-- ── 4. Rename-swap ──────────────────────────────────────────────────
ALTER TABLE audit_events RENAME TO audit_events_pre_partition_backup;
ALTER TABLE audit_events_partitioned RENAME TO audit_events;

-- Cosmetic tidy-up: constraint name still says "partitioned" since
-- renaming a table doesn't rename its constraints. Fix it so
-- pg_constraint reads naturally for the final table name.
ALTER TABLE audit_events
  RENAME CONSTRAINT audit_events_partitioned_organization_id_fkey
  TO audit_events_organization_id_fkey;

-- Re-point the seq sequence's ownership at the new column so a
-- distant-future `DROP TABLE audit_events` cascades to drop the
-- sequence too, matching original bigserial semantics.
DO $$
DECLARE
  seq_name text := pg_get_serial_sequence('audit_events_pre_partition_backup', 'seq');
BEGIN
  EXECUTE format('ALTER SEQUENCE %s OWNED BY audit_events.seq', seq_name);
END $$;

-- ── 5. Reusable partition-creation function ─────────────────────────
-- References `audit_events` by its FINAL name — must be created AFTER
-- the rename above. Idempotent (CREATE TABLE IF NOT EXISTS): safe to
-- call repeatedly, including for a month that already has a partition.
-- Used both for the initial buffer below and by the
-- ensure-audit-event-partitions scheduled job going forward
-- (src/jobs/ensureAuditEventPartitions.ts).
CREATE OR REPLACE FUNCTION create_audit_events_partition(month_start date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  partition_name text := format(
    'audit_events_y%sm%s',
    to_char(month_start, 'YYYY'),
    to_char(month_start, 'MM')
  );
  range_start text := to_char(month_start, 'YYYY-MM-DD');
  range_end text := to_char(month_start + INTERVAL '1 month', 'YYYY-MM-DD');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)',
    partition_name, range_start, range_end
  );
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', partition_name);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I '
    'USING (organization_id = app_current_org_id()) '
    'WITH CHECK (organization_id = app_current_org_id())',
    partition_name
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user, app_worker, app_admin',
    partition_name
  );
END;
$$;

-- ── 6. Initial partition buffer ─────────────────────────────────────
-- Current month + 2 months ahead, so writes don't fall into DEFAULT
-- immediately after this migration runs. The scheduled job maintains
-- this buffer going forward; see src/jobs/ensureAuditEventPartitions.ts.
SELECT create_audit_events_partition(date_trunc('month', now())::date);
SELECT create_audit_events_partition((date_trunc('month', now()) + INTERVAL '1 month')::date);
SELECT create_audit_events_partition((date_trunc('month', now()) + INTERVAL '2 months')::date);
