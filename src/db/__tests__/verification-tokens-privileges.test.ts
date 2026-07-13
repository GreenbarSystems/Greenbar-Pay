/**
 * F2 fix (2026-07-12 security audit): verification_tokens must be
 * unreachable by app_user / app_worker. Only src/lib/auth-adapter.ts
 * touches this table, and it exclusively uses the BYPASSRLS app_admin
 * connection (rawAdminDb) — app_user/app_worker have no legitimate
 * reason to hold any privilege on it. Before
 * sidecar/0031_verification_tokens_least_privilege.sql, both roles held
 * SELECT/INSERT/UPDATE/DELETE via 0001_rls.sql's blanket
 * `GRANT ... ON ALL TABLES`, which — combined with this table having no
 * RLS policy (it's cross-tenant by nature; see schema comment) — meant
 * the lowest-trust role could read or forge magic-link tokens for any
 * tenant given any SQL-injection primitive, however unlikely.
 *
 * Runs against the local Postgres from docker-compose, same as
 * rls.test.ts. Requires DATABASE_URL (app_user) and DATABASE_URL_WORKER
 * (app_worker) — falls back to DATABASE_URL if the worker URL isn't set,
 * matching src/db/internal/rawClient.ts's own fallback.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

const USER_URL = process.env.DATABASE_URL!;
const WORKER_URL = process.env.DATABASE_URL_WORKER ?? USER_URL;
const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let userPool: Pool;
let workerPool: Pool;
let adminPool: Pool;

beforeAll(() => {
  if (!USER_URL || !ADMIN_URL) {
    throw new Error("DATABASE_URL and DATABASE_URL_ADMIN must be set");
  }
  userPool = new Pool({ connectionString: USER_URL });
  workerPool = new Pool({ connectionString: WORKER_URL });
  adminPool = new Pool({ connectionString: ADMIN_URL });
});

afterAll(async () => {
  await userPool.end();
  await workerPool.end();
  await adminPool.end();
});

describe("verification_tokens least privilege (audit F2)", () => {
  it("app_user has no SELECT/INSERT/UPDATE/DELETE on verification_tokens", async () => {
    const { rows } = await adminPool.query(
      `select
         has_table_privilege('app_user', 'verification_tokens', 'SELECT') as sel,
         has_table_privilege('app_user', 'verification_tokens', 'INSERT') as ins,
         has_table_privilege('app_user', 'verification_tokens', 'UPDATE') as upd,
         has_table_privilege('app_user', 'verification_tokens', 'DELETE') as del`,
    );
    expect(rows[0]).toEqual({
      sel: false,
      ins: false,
      upd: false,
      del: false,
    });
  });

  it("app_worker has no SELECT/INSERT/UPDATE/DELETE on verification_tokens", async () => {
    const { rows } = await adminPool.query(
      `select
         has_table_privilege('app_worker', 'verification_tokens', 'SELECT') as sel,
         has_table_privilege('app_worker', 'verification_tokens', 'INSERT') as ins,
         has_table_privilege('app_worker', 'verification_tokens', 'UPDATE') as upd,
         has_table_privilege('app_worker', 'verification_tokens', 'DELETE') as del`,
    );
    expect(rows[0]).toEqual({
      sel: false,
      ins: false,
      upd: false,
      del: false,
    });
  });

  it("app_admin (BYPASSRLS) retains full access — auth-adapter.ts still works", async () => {
    const { rows } = await adminPool.query(
      `select
         has_table_privilege('app_admin', 'verification_tokens', 'SELECT') as sel,
         has_table_privilege('app_admin', 'verification_tokens', 'INSERT') as ins,
         has_table_privilege('app_admin', 'verification_tokens', 'UPDATE') as upd,
         has_table_privilege('app_admin', 'verification_tokens', 'DELETE') as del`,
    );
    expect(rows[0]).toEqual({ sel: true, ins: true, upd: true, del: true });
  });

  it("app_user connection is actually rejected at the SQL level, not just has_table_privilege", async () => {
    await expect(
      userPool.query(
        `select identifier, token from verification_tokens limit 1`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("app_worker connection is actually rejected at the SQL level", async () => {
    await expect(
      workerPool.query(
        `select identifier, token from verification_tokens limit 1`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
