-- F2 fix (2026-07-12 security audit) — verification_tokens least privilege.
--
-- verification_tokens holds plaintext Auth.js magic-link tokens. It is
-- deliberately excluded from the tenant_tables list in 0001_rls.sql
-- (see that file's comment and src/db/schema/verificationTokens.ts):
-- at sign-in time we don't yet know the user's org, so RLS can't apply
-- and the table has NO row-level policy at all.
--
-- The only code that ever touches this table is src/lib/auth-adapter.ts,
-- and it exclusively uses rawAdminDb (the BYPASSRLS app_admin role via
-- DATABASE_URL_ADMIN). app_user and app_worker have no legitimate reason
-- to read, write, or delete rows here — they only ever hold privilege on
-- it because 0001_rls.sql's `GRANT ... ON ALL TABLES` and matching
-- `ALTER DEFAULT PRIVILEGES` are blanket grants covering every table,
-- including this one.
--
-- Today that's not independently exploitable (no SQL-injection primitive
-- exists to abuse it — see the audit's "verified NOT vulnerable" list),
-- but it violates least-privilege: the lowest-trust role can read or
-- forge cross-tenant magic-link tokens with zero additional bugs beyond
-- "some future code path executes attacker-influenced SQL as app_user".
-- Revoking removes that blast-radius entirely rather than relying on
-- RLS (which structurally cannot cover this table) as the only backstop.
--
-- Idempotent: REVOKE ... IF EXISTS-equivalent isn't a thing in Postgres,
-- but REVOKE on a grant that was never made is a silent no-op, and this
-- file can be re-run safely on any environment regardless of whether
-- 0001 has already run.

REVOKE SELECT, INSERT, UPDATE, DELETE ON verification_tokens
  FROM app_user, app_worker;

-- Defense in depth: verification_tokens is a fixed, closed table (see
-- schema comment — no future column/index migration should need to
-- re-grant on it), but explicitly documenting intent here rather than
-- leaving it to fall out of 0001's blanket ALTER DEFAULT PRIVILEGES.
-- app_admin (BYPASSRLS) keeps full access — no change to app_admin.
COMMENT ON TABLE verification_tokens IS
  'Auth.js magic-link tokens. Cross-tenant by nature (no org known at '
  'sign-in) so RLS cannot apply. Access restricted to app_admin only — '
  'see sidecar/0031_verification_tokens_least_privilege.sql (audit F2). '
  'Do not grant app_user/app_worker privileges on this table.';
