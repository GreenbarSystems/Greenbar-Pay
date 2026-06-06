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

const userPool = new Pool({ connectionString: USER_URL, max: 10 });
const workerPool = new Pool({ connectionString: WORKER_URL, max: 10 });
const adminPool = new Pool({ connectionString: ADMIN_URL, max: 4 });

export const rawUserDb = drizzle(userPool, { schema });
export const rawWorkerDb = drizzle(workerPool, { schema });
/** BYPASSRLS — use only for cross-tenant operations. See note above. */
export const rawAdminDb = drizzle(adminPool, { schema });

export type RawDb = typeof rawUserDb;
export { userPool, workerPool, adminPool };
