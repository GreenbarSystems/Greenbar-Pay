/**
 * Per-org daily quota (addendum §2.7).
 *
 *   "Soft default: 1,000 documents/day. Exceeding the quota enqueues
 *    with status='throttled'; quota resets at org-local midnight."
 *
 * Phase 3 implementation: count `llm_runs` rows for the org since
 * UTC midnight. Org-local midnight requires per-org timezone config,
 * which lands with per-org settings. UTC is the conservative default.
 *
 * The metered set is `succeeded | schema_failed | provider_error` —
 * i.e. anything that actually dispatched to the model. Pre-flight
 * rejections (text_too_large / quota_exceeded / circuit_open) never
 * left the gateway and don't count. This is intentionally NOT
 * "succeeded only": a model that always schema-fails would otherwise
 * let an org spam infinitely.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import { llmRuns } from "@/db/schema";

export const DEFAULT_DAILY_QUOTA = 1000;

export async function quotaRemaining(
  organizationId: string,
  limit = DEFAULT_DAILY_QUOTA,
): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const used = await withOrgAsWorker(organizationId, async (tx) => {
    // PR4 — review #18: SQL count(*) instead of materializing every row
    // back to the worker process. The composite index added in
    // 0008_pr4_scale.sql covers (organization_id, status, created_at)
    // so the recheck is index-only — no heap fetches.
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(llmRuns)
      .where(
        and(
          eq(llmRuns.organizationId, organizationId),
          inArray(llmRuns.status, ["succeeded", "schema_failed", "provider_error"]),
          gte(llmRuns.createdAt, startOfDay),
        ),
      );
    return row?.count ?? 0;
  });

  return Math.max(0, limit - used);
}
