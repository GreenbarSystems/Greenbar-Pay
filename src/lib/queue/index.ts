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
      // PR20 — pg-boss archive + delete retention. Defaults keep
      // completed jobs in `pgboss.archive` for 14 days, then delete
      // forever. At pilot scale (~2k jobs/day) the table accretes
      // slowly but unboundedly without explicit hygiene. 7-day
      // archive + 24-hour delete-after-complete keeps the table
      // surface small while leaving an operator-debuggable window.
      archiveCompletedAfterSeconds: 24 * 3600,
      deleteAfterDays: 7,
    });
    b.on("error", (err) => console.error("[pg-boss]", err));
    await b.start();
    // pg-boss v10 dropped auto-create-on-work/send: every named queue
    // must exist as a row in pgboss.queue (via createQueue) before
    // work()/schedule()/send() will succeed -- otherwise they fail with
    // a queue foreign-key violation ("Queue <name> not found"). This
    // module is the single shared entrypoint used by both the web app
    // (send) and the worker process (work/schedule), so creating every
    // queue here -- rather than only in scripts/worker.ts -- covers
    // both call sites and boot orderings (e.g. web app enqueuing before
    // the worker has ever started). create_queue() is ON CONFLICT DO
    // NOTHING under the hood, so calling it on every process boot is
    // safe/idempotent -- but sequentially, not via Promise.all: firing
    // 10 concurrent createQueue() calls at boot triggered real Postgres
    // "deadlock detected" errors in CI (multiple sessions racing to
    // insert into pgboss.queue's underlying constraints/triggers at
    // once). Sequential awaits avoid the contention entirely and only
    // add a few ms to boot time.
    for (const name of Object.values(JOB)) {
      await b.createQueue(name);
    }
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
  exportInvoices: "export-invoices",
  recomputeVendorProfile: "recompute-vendor-profile",
  generateBriefingCard: "generate-briefing-card",
  // Phase 11 — D4
  assembleEvidencePacket: "assemble-evidence-packet",
  // Phase 9.5 — D3 second half
  extractContractData: "extract-contract-data",
  // Slice 2 — correction-aware RAG flywheel
  captureAndEmbedCorrection: "capture-and-embed-correction",
  // Hygiene — runs on a cron schedule (boss.schedule in scripts/worker.ts).
  // Deletes api_idempotency_keys rows past their 24h TTL.
  cleanupIdempotencyKeys: "cleanup-idempotency-keys",
  // Hygiene — runs on a cron schedule. Keeps audit_events' RANGE
  // partitions (migration 0030) created ahead of the calendar.
  ensureAuditEventPartitions: "ensure-audit-event-partitions",
  // Accounting integrations — push approved invoices to QBO / Xero.
  syncToQbo: "sync-to-qbo",
  syncToXero: "sync-to-xero",
} as const;

export type JobPayloads = {
  [JOB.processDocument]: { documentId: string; organizationId: string };
  [JOB.extractInvoiceData]: { documentId: string; organizationId: string };
  [JOB.validateExtractedInvoice]: {
    extractedInvoiceId: string;
    organizationId: string;
  };
  [JOB.exportInvoices]: { exportId: string; organizationId: string };
  [JOB.recomputeVendorProfile]: { vendorId: string; organizationId: string };
  [JOB.generateBriefingCard]: {
    extractedInvoiceId: string;
    organizationId: string;
  };
  [JOB.assembleEvidencePacket]: {
    extractedInvoiceId: string;
    organizationId: string;
  };
  // Phase 9.5 — D3 second half. Same shape as extract-invoice-data.
  [JOB.extractContractData]: {
    documentId: string;
    organizationId: string;
  };
  // Slice 2 — capture reviewer corrections + generate voyage-3 embedding.
  [JOB.captureAndEmbedCorrection]: {
    extractedInvoiceId: string;
    organizationId: string;
  };
  // Hygiene job — no payload; cross-tenant cleanup.
  [JOB.cleanupIdempotencyKeys]: Record<string, never>;
  // Hygiene job — no payload; cross-tenant DDL maintenance.
  [JOB.ensureAuditEventPartitions]: Record<string, never>;
  // Accounting integrations.
  [JOB.syncToQbo]: { exportId: string; organizationId: string };
  [JOB.syncToXero]: { exportId: string; organizationId: string };
};
