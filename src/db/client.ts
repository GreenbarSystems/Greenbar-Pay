/**
 * withOrg(orgId, fn) — the single entry point for tenant-scoped DB work
 * (addendum §1.4). Opens a transaction, pins the GUC, runs the callback.
 *
 *   SET LOCAL scopes the GUC to the transaction; pooling cannot leak it.
 *
 * Direct drizzle access is blocked by the ESLint rule in .eslintrc.cjs.
 */
import { sql } from "drizzle-orm";
import { rawUserDb, rawWorkerDb, type RawDb } from "@/db/internal/rawClient";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Parameters<Parameters<RawDb["transaction"]>[0]>[0];

function assertOrg(orgId: string): string {
  if (!UUID_RE.test(orgId)) {
    // Belt-and-braces against SQL injection into SET LOCAL. We bind the value
    // as a parameter below, but reject malformed input early either way.
    throw new Error(`withOrg: invalid organizationId ${JSON.stringify(orgId)}`);
  }
  return orgId;
}

async function run<T>(db: RawDb, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const safeOrg = assertOrg(orgId);
  return db.transaction(async (tx) => {
    // set_config(name, value, is_local=true) is the parameterized equivalent
    // of `SET LOCAL` — keeps the value out of the SQL string.
    await tx.execute(sql`select set_config('app.current_org_id', ${safeOrg}, true)`);
    return fn(tx);
  });
}

/** Tenant-scoped query for request-handling code (Next.js routes/actions). */
export function withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return run(rawUserDb, orgId, fn);
}

/** Tenant-scoped query for background workers. */
export function withOrgAsWorker<T>(
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return run(rawWorkerDb, orgId, fn);
}
