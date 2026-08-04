/**
 * Migration 0037 — TRUNCATE is not blocked by the append-only RULES
 * from migration 0030 (Postgres RULES never intercept TRUNCATE, a
 * language limitation, not a bug). This proves the explicit REVOKE
 * closes that gap for app_user and app_worker — the roles the running
 * application and its background jobs actually connect as.
 *
 * has_table_privilege() reflects the CURRENT effective privilege
 * (ownership, role membership, and explicit grants/revokes combined),
 * so this is a direct assertion on runtime behavior, not just "did the
 * migration file contain the word REVOKE."
 *
 * Runs against the local Postgres from docker-compose. Requires
 * DATABASE_URL (app_user), DATABASE_URL_WORKER (app_worker), and
 * DATABASE_URL_ADMIN (app_admin — read-only use here, to run
 * has_table_privilege as an unambiguous third party).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let adminPool: Pool;

beforeAll(() => {
  if (!ADMIN_URL) {
    throw new Error("DATABASE_URL_ADMIN must be set");
  }
  adminPool = new Pool({ connectionString: ADMIN_URL });
});

afterAll(async () => {
  await adminPool.end();
});

async function canTruncate(role: "app_user" | "app_worker" | "app_admin", relation: string) {
  const { rows } = await adminPool.query(
    `select has_table_privilege($1, $2, 'TRUNCATE') as can_truncate`,
    [role, relation],
  );
  return rows[0].can_truncate as boolean;
}

describe("audit_events TRUNCATE privilege", () => {
  it("app_user cannot TRUNCATE audit_events or its default partition", async () => {
    expect(await canTruncate("app_user", "audit_events")).toBe(false);
    expect(await canTruncate("app_user", "audit_events_default")).toBe(false);
  });

  it("app_worker cannot TRUNCATE audit_events or its default partition", async () => {
    expect(await canTruncate("app_worker", "audit_events")).toBe(false);
    expect(await canTruncate("app_worker", "audit_events_default")).toBe(false);
  });

  it("a freshly created monthly partition also blocks app_user and app_worker", async () => {
    // Exercise create_audit_events_partition() directly rather than
    // waiting for real data — proves the REVOKE embedded in the
    // function (not just the one-time backfill loop) actually fires.
    const monthStart = "2031-01-01"; // far future — collision-free across test runs
    await adminPool.query(`select create_audit_events_partition($1::date)`, [monthStart]);
    expect(await canTruncate("app_user", "audit_events_y2031m01")).toBe(false);
    expect(await canTruncate("app_worker", "audit_events_y2031m01")).toBe(false);
  });

  it("app_admin retains TRUNCATE as table owner (documented, accepted exposure)", async () => {
    // Not a gap this migration is meant to close — see 0037's header
    // comment. Asserted here so a future attempt to also lock down
    // app_admin doesn't silently break without this test flagging the
    // intentional-behavior change.
    expect(await canTruncate("app_admin", "audit_events")).toBe(true);
  });
});
