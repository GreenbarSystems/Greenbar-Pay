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
-- CORRECTNESS NOTE (post-review fix): an earlier version of this
-- migration copied all historical rows into a DEFAULT partition and
-- then relied on "Postgres automatically migrates rows out of DEFAULT
-- when an overlapping explicit partition is created." That claim is
-- FALSE. Postgres instead SCANS the DEFAULT partition and RAISES AN
-- ERROR if it finds any row that would belong in the new partition's
-- range — it never auto-moves rows. Because the original step order
-- copied data into DEFAULT *before* creating the current-month
-- partition, this was a guaranteed failure on any database with
-- same-month pre-existing rows (i.e. any live system, ever) — it only
-- "passed" in CI because CI's Postgres is provisioned empty and
-- migrations run before any row is ever inserted, so DEFAULT was
-- empty and the scan found nothing to conflict with. This version
-- fixes it by computing the actual historical date range and
-- pre-creating every needed monthly partition BEFORE copying any
-- data, so no row ever needs to move out of DEFAULT — each lands
-- directly in its correct partition on first insert.
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
--   - A DEFAULT partition still exists as a safety net for any row
--     that ever falls outside the explicitly-created monthly ranges
--     (e.g. the partition-maintenance job falling behind by more than
--     its buffer window) — but after this migration it starts and
--     stays EMPTY under normal operation, because every historical
--     month gets its own explicit partition up front. See
--     create_audit_events_partition()'s error handling below for what
--     happens if a future partition creation ever DOES conflict with
--     real data that accumulated in DEFAULT, and CLAUDE.md for the
--     manual recovery procedure.
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
-- name, rename it into place FIRST (before any data copy — needed so
-- create_audit_events_partition() can reference the table by its
-- final name while pre-creating historical partitions), then copy
-- existing rows in. This blocks writes to audit_events for the
-- duration, acceptable at current (pre-pilot) data volume. The OLD
-- table is renamed to audit_events_pre_partition_backup rather than
-- dropped; an operator should verify the new table looks right in
-- production, THEN drop the backup in a follow-up migration once
-- satisfied. See CLAUDE.md for the operational note on when it's safe
-- to drop.

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

-- ── 2. DEFAULT partition — safety net only, must stay empty ─────────
-- Historical data does NOT land here anymore (see step 6) — this only
-- catches a row that somehow falls outside every explicitly-created
-- monthly range (the partition-maintenance job falling behind).
CREATE TABLE IF NOT EXISTS audit_events_default
  PARTITION OF audit_events_partitioned DEFAULT;
ALTER TABLE audit_events_default ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events_default FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_events_default;
CREATE POLICY tenant_isolation ON audit_events_default
  USING      (organization_id = app_current_org_id())
  WITH CHECK (organization_id = app_current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_events_default TO app_user, app_worker, app_admin;

-- ── 3. Rename-swap ───────────────────────────────────────────────────
-- Happens BEFORE the data copy (unlike the original version of this
-- migration) so create_audit_events_partition() can reference the
-- table by its final name while pre-creating historical partitions
-- in step 6, before any data lands in DEFAULT.
ALTER TABLE audit_events RENAME TO audit_events_pre_partition_backup;
ALTER TABLE audit_events_partitioned RENAME TO audit_events;

-- Cosmetic tidy-up: constraint/rule names still say "partitioned"
-- since renaming a table doesn't rename its constraints or rules.
-- Fix them so pg_constraint / pg_rewrite read naturally for the final
-- table name.
ALTER TABLE audit_events
  RENAME CONSTRAINT audit_events_partitioned_organization_id_fkey
  TO audit_events_organization_id_fkey;
ALTER RULE audit_events_partitioned_no_update ON audit_events RENAME TO audit_events_no_update;
ALTER RULE audit_events_partitioned_no_delete ON audit_events RENAME TO audit_events_no_delete;

-- Re-point the seq sequence's ownership at the new column so a
-- distant-future `DROP TABLE audit_events_pre_partition_backup` (the
-- eventual cleanup of the renamed-away original) doesn't cascade-drop
-- the sequence the LIVE table still depends on.
DO $$
DECLARE
  seq_name text := pg_get_serial_sequence('audit_events_pre_partition_backup', 'seq');
BEGIN
  EXECUTE format('ALTER SEQUENCE %s OWNED BY audit_events.seq', seq_name);
END $$;

-- ── 4. Reusable partition-creation function ─────────────────────────
-- References `audit_events` by its FINAL name — valid immediately
-- since the rename already happened in step 3. Idempotent (CREATE
-- TABLE IF NOT EXISTS): safe to call repeatedly, including for a
-- month that already has a partition. Used both for the historical
-- backfill in step 6 below and by the ensure-audit-event-partitions
-- scheduled job going forward (src/jobs/ensureAuditEventPartitions.ts).
--
-- Error handling: if DEFAULT ever genuinely holds a row for the month
-- being created (the scheduled job fell behind by more than its
-- buffer window, or an operator is re-running this by hand long after
-- the fact), the underlying CREATE TABLE ... PARTITION OF fails with
-- Postgres's own "updated partition constraint for default partition
-- would be violated by some row" error. That message is accurate but
-- not actionable to an on-call engineer at 3am, so it's caught and
-- re-raised with the month, the original error text, and a pointer to
-- the recovery procedure in CLAUDE.md. This does NOT attempt to
-- auto-heal (which would require briefly dropping the append-only
-- RULE inside an unattended cron job) — it fails loudly with enough
-- context to fix it by hand.
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
  BEGIN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)',
      partition_name, range_start, range_end
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'create_audit_events_partition(%): failed to create partition %. '
      'If the underlying error is about the default partition''s '
      'constraint being violated, audit_events_default already holds '
      'real rows for this month (the partition-maintenance job fell '
      'behind by more than its buffer window). See CLAUDE.md '
      '"Recovering a missed audit_events partition" for the manual fix '
      '— do not retry blindly, it will fail the same way. '
      'Original error: %',
      month_start, partition_name, SQLERRM;
  END;

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

-- ── 5. Historical partition backfill ────────────────────────────────
-- Computes the actual min/max created_at from the OLD table (still
-- intact under its renamed-away name — untouched by anything above)
-- and pre-creates one partition per month across that range, PLUS a
-- buffer past the latest month. This must happen BEFORE the data copy
-- in step 6 so every row has a matching explicit partition to land in
-- directly — none of them touch DEFAULT.
--
-- Sanity cap: refuses to create more than 240 (20 years) of monthly
-- partitions in one run. This table's realistic data doesn't span
-- anywhere near that; the cap exists purely to fail loudly rather
-- than silently creating an absurd number of empty partitions if
-- created_at ever contains a corrupt/out-of-range value (e.g. a
-- clock-skew bug elsewhere writing a year-1970 or year-9999 row).
DO $$
DECLARE
  earliest date;
  latest date;
  cursor_month date;
  total_months int;
  max_months constant int := 240;
BEGIN
  SELECT
    date_trunc('month', MIN(created_at))::date,
    date_trunc('month', MAX(created_at))::date
  INTO earliest, latest
  FROM audit_events_pre_partition_backup;

  -- Empty old table (fresh install, matches what CI always sees): no
  -- historical data to backfill, just anchor on the current month.
  IF earliest IS NULL THEN
    earliest := date_trunc('month', now())::date;
  END IF;

  -- Always cover through at least the current month, regardless of
  -- the historical max, in case of clock skew or a long gap between
  -- the last historical row and "now" at migration time.
  latest := GREATEST(latest, date_trunc('month', now())::date);

  total_months := (EXTRACT(YEAR FROM latest)::int - EXTRACT(YEAR FROM earliest)::int) * 12
                + (EXTRACT(MONTH FROM latest)::int - EXTRACT(MONTH FROM earliest)::int);

  IF total_months > max_months THEN
    RAISE EXCEPTION
      'audit_events historical date range (% to %) would require % '
      'monthly partitions, exceeding the sanity cap of %. Investigate '
      'whether created_at contains corrupt or out-of-range values '
      '(e.g. clock skew) before re-running this migration.',
      earliest, latest, total_months, max_months;
  END IF;

  cursor_month := earliest;
  WHILE cursor_month <= latest LOOP
    PERFORM create_audit_events_partition(cursor_month);
    cursor_month := cursor_month + INTERVAL '1 month';
  END LOOP;

  -- Buffer beyond "latest" (which already covers at least the current
  -- month) so writes don't fall into DEFAULT immediately after this
  -- migration runs. The scheduled job maintains this buffer going
  -- forward; see src/jobs/ensureAuditEventPartitions.ts.
  PERFORM create_audit_events_partition((latest + INTERVAL '1 month')::date);
  PERFORM create_audit_events_partition((latest + INTERVAL '2 months')::date);
END $$;

-- ── 6. Copy existing rows ───────────────────────────────────────────
-- Every relevant month already has an explicit partition from step 5,
-- so every row lands directly in its correct monthly partition —
-- none of them touch DEFAULT, and no conflict-scan failure is
-- possible here.
INSERT INTO audit_events
  (id, organization_id, actor_type, actor_id, action, entity_type,
   entity_id, before_json, after_json, metadata_json, created_at, seq)
SELECT
  id, organization_id, actor_type, actor_id, action, entity_type,
  entity_id, before_json, after_json, metadata_json, created_at, seq
FROM audit_events_pre_partition_backup;
