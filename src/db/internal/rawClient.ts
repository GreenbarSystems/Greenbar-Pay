/**
 * The ONLY file allowed to import the raw drizzle driver. The ESLint rule
 * (.eslintrc.cjs) exempts this path. All callers must use `withOrg`.
 *
 * `rawAdminDb` exists for legitimately cross-tenant work — only the AP
 * inbox ingestion uses it today, to resolve the org from a recipient
 * address before the GUC can be set. Adding any new caller requires a
 * code-review sign-off; abuse here defeats the §1.2 isolation model.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";

const USER_URL = process.env.DATABASE_URL!;
const WORKER_URL = process.env.DATABASE_URL_WORKER ?? USER_URL;
const ADMIN_URL = process.env.DATABASE_URL_ADMIN ?? WORKER_URL;

// PR20 — pool capacity. The pre-pilot review math: validateExtractedInvoice
// runs at teamSize=4 × teamConcurrency=4 = 16 simultaneous slots,
// recomputeVendorProfile at 8, assembleEvidencePacket at 8 (post-PR17),
// the rest at ≤4. Under a 15-invoice approval burst, workerPool can see
// 24+ concurrent connection requests against a max=10 cap, queueing
// handlers for seconds. Raising both to 25 still comfortably fits a
// typical managed Postgres `max_connections` of 100 and gives the
// burst paths headroom. Override per-deployment via env if needed.
const userPool = new Pool({
  connectionString: USER_URL,
  max: Number(process.env.DATABASE_POOL_MAX_USER ?? 15),
});
const workerPool = new Pool({
  connectionString: WORKER_URL,
  max: Number(process.env.DATABASE_POOL_MAX_WORKER ?? 25),
});
const adminPool = new Pool({
  connectionString: ADMIN_URL,
  max: Number(process.env.DATABASE_POOL_MAX_ADMIN ?? 4),
});

export const rawUserDb = drizzle(userPool, { schema });
export const rawWorkerDb = drizzle(workerPool, { schema });
/** BYPASSRLS — use only for cross-tenant operations. See note above. */
export const rawAdminDb = drizzle(adminPool, { schema });

export type RawDb = typeof rawUserDb;
export { userPool, workerPool, adminPool };
