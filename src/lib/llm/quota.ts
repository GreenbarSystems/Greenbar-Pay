/**
 * Per-org daily quota (addendum §2.7).
 *
 *   "Soft default: 1,000 documents/day. Exceeding the quota enqueues
 *    with status='throttled'; quota resets at org-local midnight."
 *
 * Phase 3 implementation: count successful llm_runs for the org since
 * UTC midnight. Org-local midnight requires per-org timezone config,
 * which lands with per-org settings. UTC is the conservative default.
 *
 * Counting succeeded runs (rather than enqueues) means a retry-bombing
 * runaway doesn't burn quota. A failed run doesn't count against the
 * limit.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
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
    const rows = await tx
      .select({ id: llmRuns.id })
      .from(llmRuns)
      .where(
        and(
          eq(llmRuns.organizationId, organizationId),
          inArray(llmRuns.status, ["succeeded", "schema_failed", "provider_error"]),
          gte(llmRuns.createdAt, startOfDay),
        ),
      );
    return rows.length;
  });

  return Math.max(0, limit - used);
}
