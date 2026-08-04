-- Revoke TRUNCATE on audit_events, defense-in-depth alongside the
-- append-only RULES from migration 0030.
--
-- Postgres RULES (ON UPDATE/DELETE DO INSTEAD NOTHING) never intercept
-- TRUNCATE — that's a hard language limitation, not a bug in 0030.
-- TRUNCATE also isn't part of the default privilege set: only a
-- table's owner, or a role explicitly GRANTed TRUNCATE, can run it.
-- Every GRANT in 0030 (and in create_audit_events_partition() for each
-- monthly partition) only ever lists SELECT, INSERT, UPDATE, DELETE —
-- so app_user and app_worker were never able to TRUNCATE this table in
-- the first place. This migration makes that explicit and permanent
-- instead of leaving it as an accident of "nobody happened to GRANT
-- it" — REVOKE is a documented no-op when the privilege was never
-- granted, so this is safe to run regardless of current state.
--
-- Residual, accepted exposure: app_admin is the role DATABASE_URL_ADMIN
-- connects as, and is therefore the OWNER of every table these
-- migrations create (Postgres makes the executing role the owner on
-- CREATE TABLE). Table owners always retain TRUNCATE — and DROP, and
-- ALTER — regardless of any REVOKE; only reassigning ownership to a
-- role application code never authenticates as would close that,
-- which is a bigger change than this migration (splitting a
-- migration-only owner role out of app_admin) and is deliberately out
-- of scope here. This isn't a new risk: app_admin is BYPASSRLS and
-- already documented (CLAUDE.md, "Recovering a missed audit_events
-- partition") as trusted to DROP the append-only RULES by hand during
-- recovery. app_admin credentials are ops-only — no per-request
-- application code path authenticates as app_admin to serve a user
-- action; see CLAUDE.md's BYPASSRLS usage note. What this migration
-- closes is the every-day risk surface: app_user and app_worker (what
-- the running application and its background jobs actually connect
-- as) can now provably never TRUNCATE the audit trail, not just
-- "currently don't because nobody granted it."
REVOKE TRUNCATE ON audit_events FROM PUBLIC, app_user, app_worker;
REVOKE TRUNCATE ON audit_events_default FROM PUBLIC, app_user, app_worker;

-- Same for every already-created monthly partition (audit_events_yYYYYmMM).
DO $$
DECLARE
  partition record;
BEGIN
  FOR partition IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'audit_events'
  LOOP
    EXECUTE format(
      'REVOKE TRUNCATE ON %I FROM PUBLIC, app_user, app_worker',
      partition.relname
    );
  END LOOP;
END $$;

-- Keep future partitions covered: create_audit_events_partition() (see
-- migration 0030) grants SELECT/INSERT/UPDATE/DELETE per partition but
-- never granted TRUNCATE either — add the same explicit REVOKE there
-- so the intent survives independent of grant history, matching this
-- migration's REVOKEs above. CREATE OR REPLACE FUNCTION, same
-- signature and body as 0030 plus the one new line.
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
  -- 2026-08 hardening (migration 0037) — see this migration's header
  -- comment for the full rationale.
  EXECUTE format(
    'REVOKE TRUNCATE ON %I FROM PUBLIC, app_user, app_worker',
    partition_name
  );
END;
$$;
