/**
 * capture-and-embed-correction job (Slice 2).
 *
 * Triggered post-approve by the approve route. Two steps:
 *
 *   1. Capture — load invoice.edited audit events, diff before/after,
 *      insert into extraction_corrections (idempotent on retry via
 *      ON CONFLICT DO NOTHING).
 *
 *   2. Embed — call Voyage AI voyage-3 to generate a 1024-dim embedding
 *      of the correction context text; persist on the row.
 *
 * Either step can be skipped:
 *   - No reviewer edits before approval → capture returns null → done.
 *   - VOYAGE_API_KEY unset → embedding returns null → done (row exists
 *     with null embedding; vendor fallback retrieval handles it).
 *
 * batchSize: 4 — Voyage API calls are cheap and fast; the main limit
 * is the network round trip, not the connection pool.
 */
import type PgBoss from "pg-boss";
import { eq } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import { extractionCorrections } from "@/db/schema";
import { captureApproveCorrections } from "@/lib/corrections";
import { generateEmbedding } from "@/lib/embeddings";
import { scrubError } from "@/lib/llm/scrub";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

export async function handleCaptureAndEmbedCorrection(
  job: PgBoss.Job<JobPayloads[typeof JOB.captureAndEmbedCorrection]>,
): Promise<void> {
  const { extractedInvoiceId, organizationId } = job.data;

  // Step 1: Capture the reviewer corrections (idempotent).
  const captured = await captureApproveCorrections({
    extractedInvoiceId,
    organizationId,
  });

  if (!captured) return; // no reviewer edits — nothing to embed

  // Step 2: Generate embedding (skip if VOYAGE_API_KEY unset).
  let embedding: number[] | null;
  try {
    embedding = await generateEmbedding(captured.contextText);
  } catch (err) {
    // Log and bail — the correction row exists with null embedding.
    // The next job retry will attempt embedding again.
    console.warn(
      `[capture-and-embed-correction] Voyage AI call failed for invoice=${extractedInvoiceId}; correction captured, embedding will retry`,
      scrubError(err),
    );
    throw err; // let pg-boss retry
  }

  if (!embedding) return; // VOYAGE_API_KEY unset — null embedding is OK

  // Step 3: Persist the embedding on the correction row.
  await withOrgAsWorker(organizationId, async (tx) => {
    await tx
      .update(extractionCorrections)
      .set({ embedding })
      .where(eq(extractionCorrections.id, captured.correctionId));
  });
}
