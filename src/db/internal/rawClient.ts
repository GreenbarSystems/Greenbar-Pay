/**
 * The ONLY file allowed to import the raw drizzle driver. The ESLint rule
 * (.eslintrc.cjs) exempts this path. All callers must use `withOrg`.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";

const USER_URL = process.env.DATABASE_URL!;
const WORKER_URL = process.env.DATABASE_URL_WORKER ?? USER_URL;

const userPool = new Pool({ connectionString: USER_URL, max: 10 });
const workerPool = new Pool({ connectionString: WORKER_URL, max: 10 });

export const rawUserDb = drizzle(userPool, { schema });
export const rawWorkerDb = drizzle(workerPool, { schema });

export type RawDb = typeof rawUserDb;
export { userPool, workerPool };
