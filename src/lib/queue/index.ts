/**
 * pg-boss singleton. Use `getQueue()` from server actions / route handlers
 * to enqueue work; the dedicated `scripts/worker.ts` process registers
 * handlers and drains.
 *
 * pg-boss uses `SELECT … FOR UPDATE SKIP LOCKED` internally — matches the
 * claim semantics required by addendum §4.4.
 */
import PgBoss from "pg-boss";

const ADMIN_URL =
  process.env.DATABASE_URL_ADMIN ??
  "postgres://app_admin:app_admin_pw@localhost:5432/greenbar";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export async function getQueue(): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;
  starting = (async () => {
    const b = new PgBoss({
      connectionString: ADMIN_URL, // pg-boss needs DDL for its own schema
      schema: "pgboss",
      retryLimit: 5,
      retryDelay: 30, // seconds
      retryBackoff: true,
    });
    b.on("error", (err) => console.error("[pg-boss]", err));
    await b.start();
    boss = b;
    return b;
  })();
  return starting;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ timeout: 10_000 });
    boss = null;
  }
  starting = null;
}

/** Canonical job names. Keep in lockstep with the registry in src/jobs. */
export const JOB = {
  processDocument: "process-document",
  extractInvoiceData: "extract-invoice-data",
  validateExtractedInvoice: "validate-extracted-invoice",
} as const;

export type JobPayloads = {
  [JOB.processDocument]: { documentId: string; organizationId: string };
  [JOB.extractInvoiceData]: { documentId: string; organizationId: string };
  [JOB.validateExtractedInvoice]: {
    extractedInvoiceId: string;
    organizationId: string;
  };
};
