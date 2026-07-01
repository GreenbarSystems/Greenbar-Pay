/**
 * ensure-audit-event-partitions — scheduled hygiene job.
 *
 * audit_events is RANGE-partitioned by created_at (monthly), added in
 * migration 0030. New partitions must exist BEFORE a row with a
 * matching created_at is inserted, or the write falls into the
 * DEFAULT partition — still correct (no insert failure), just loses
 * the per-month performance benefit and, left unmaintained, would
 * grow the DEFAULT partition unbounded over time as every month's
 * data piles into it.
 *
 * Calls the create_audit_events_partition(month_start date) SQL
 * function (idempotent — CREATE TABLE IF NOT EXISTS, safe to call
 * repeatedly for a month that already has a partition) for the
 * current month plus a buffer, so partitions are always ready well
 * ahead of the calendar rolling over. Runs daily; cheap even though
 * partitions only need to be created monthly — the extra runs are
 * just no-ops.
 *
 * Cross-tenant by design (schema-level DDL, not tenant data) — uses
 * the admin pool (BYPASSRLS) same as cleanupIdempotencyKeys.
 */
import type PgBoss from "pg-boss";
import { sql } from "drizzle-orm";
import { rawAdminDb } from "@/db/internal/rawClient";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

const MONTHS_AHEAD = 2;

export async function handleEnsureAuditEventPartitions(
  _job: PgBoss.Job<JobPayloads[typeof JOB.ensureAuditEventPartitions]>,
): Promise<{ ensured: string[] }> {
  const ensured: string[] = [];
  const now = new Date();
  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const iso = monthStart.toISOString().slice(0, 10);
    await rawAdminDb.execute(sql`SELECT create_audit_events_partition(${iso}::date)`);
    ensured.push(iso);
  }
  console.log(
    `[ensure-audit-event-partitions] ensured partitions for: ${ensured.join(", ")}`,
  );
  return { ensured };
}
