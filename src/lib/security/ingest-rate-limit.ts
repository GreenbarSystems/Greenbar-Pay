/**
 * Per-org ingest rate limit — fixes "F4: No rate limiting or per-org
 * concurrency cap on upload/OCR/LLM path" from the 2026-07-13 security
 * audit, rescoped after verification against the actual code.
 *
 * The audit's "financial DoS (Anthropic bill)" framing doesn't hold —
 * src/lib/llm/quota.ts already caps LLM spend at
 * DEFAULT_DAILY_QUOTA/day/org, enforced pre-dispatch. What IS real:
 * only a GLOBAL (not per-org) concurrency cap exists on the OCR/LLM
 * job pipeline (batchSize: 1 for processDocument/extractInvoiceData in
 * src/jobs/index.ts), and pg-boss processes each queue strictly FIFO.
 * One org enqueuing a flood of documents — via the upload route, or
 * (combined with F11's still-open missing sender authentication) via
 * email to a guessed inbox address — can queue-starve every other
 * org's documents behind it indefinitely. Capping per-org REQUEST
 * volume at the two ingestion entry points bounds how deep that
 * flood can get, which is what actually protects the shared queue
 * (concurrency limiting alone wouldn't — batchSize:1 already means
 * only one job runs at a time system-wide; the danger is queue
 * DEPTH, not concurrent execution).
 *
 * Implementation mirrors quotaRemaining() in src/lib/llm/quota.ts:
 * count existing rows in a rolling window rather than maintaining a
 * separate counter table. Counts `documents.receivedAt` (not
 * createdAt) specifically to reuse the existing
 * idx_documents_org_received index — no new migration needed.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { documents } from "@/db/schema";

export const DEFAULT_INGEST_RATE_LIMIT = 100;
export const INGEST_RATE_LIMIT_WINDOW_MINUTES = 10;

export interface IngestRateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  windowMinutes: number;
}

/**
 * Counts this org's documents received in the last `windowMinutes`
 * (upload AND email sources share one budget — same downstream
 * OCR/LLM pipeline, same queue). Caller supplies `tx` from whichever
 * pool is contextually correct (withOrg for a request handler,
 * withOrgAsWorker for the inbox ingest worker) — this function opens
 * no connection of its own.
 */
export async function checkIngestRateLimit(
  tx: Tx,
  organizationId: string,
  limit = DEFAULT_INGEST_RATE_LIMIT,
  windowMinutes = INGEST_RATE_LIMIT_WINDOW_MINUTES,
): Promise<IngestRateLimitResult> {
  const windowStart = new Date(Date.now() - windowMinutes * 60_000);

  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(
      and(
        eq(documents.organizationId, organizationId),
        gte(documents.receivedAt, windowStart),
      ),
    );
  const used = row?.count ?? 0;

  return {
    allowed: used < limit,
    remaining: Math.max(0, limit - used),
    limit,
    windowMinutes,
  };
}
