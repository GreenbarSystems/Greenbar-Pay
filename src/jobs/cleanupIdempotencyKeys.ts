/**
 * cleanup-idempotency-keys — scheduled hourly hygiene job.
 *
 * Why this exists: `api_idempotency_keys` has a 24-hour read-side TTL
 * (handlers ignore rows older than that, see src/lib/idempotency.ts),
 * but no DELETE was ever happening. Rows accumulated indefinitely.
 * At 10k orgs × 100 req/org/day × 30 days the table is 30M rows; the
 * (organization_id, key) B-tree bloats, autovacuum can't keep up, and
 * insert latency on every mutating route degrades.
 *
 * Scope is cross-tenant by design: the cleanup deletes ALL expired
 * rows in one shot regardless of org, so it must run on the worker
 * connection without `withOrg`'s RLS GUC. We use the admin pool
 * (BYPASSRLS) for exactly this kind of org-agnostic housekeeping.
 *
 * Scheduling: pg-boss `boss.schedule('cleanup-idempotency-keys', cron)`
 * in scripts/worker.ts. Default cadence: every hour at minute 17 (avoid
 * the busy top-of-hour). Single-instance via the JOB name itself —
 * pg-boss queue ordering serializes invocations.
 */
import type PgBoss from "pg-boss";
import { sql } from "drizzle-orm";
import { rawAdminDb } from "@/db/internal/rawClient";
import { apiIdempotencyKeys } from "@/db/schema";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

const TTL_HOURS = 24;

export async function handleCleanupIdempotencyKeys(
  _job: PgBoss.Job<JobPayloads[typeof JOB.cleanupIdempotencyKeys]>,
): Promise<{ deleted: number }> {
  // Admin pool (BYPASSRLS) by design — cross-tenant housekeeping.
  // The partial index 0026_idempotency_cleanup.sql makes this DELETE
  // an index-only scan instead of a full table scan.
  const result = await rawAdminDb
    .delete(apiIdempotencyKeys)
    .where(
      sql`${apiIdempotencyKeys.createdAt} < now() - (${TTL_HOURS} || ' hours')::interval`,
    )
    .returning({ key: apiIdempotencyKeys.key });

  const deleted = result.length;
  if (deleted > 0) {
    console.log(
      `[cleanup-idempotency-keys] deleted ${deleted} rows past ${TTL_HOURS}h TTL`,
    );
  }
  return { deleted };
}
