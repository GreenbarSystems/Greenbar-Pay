/**
 * process-document — PRD §"Job: Process Document".
 *
 * Extraction order:
 *   PDF  → native pdf-parse first; if its quality score is below the
 *          threshold, retry via tesseract_pdf (pdftoppm → Tesseract per
 *          page). The better of the two by quality score wins.
 *   IMG  → tesseract_image directly.
 *
 * Steps:
 *   1. Load document row + compare-and-set status to 'processing' (§4.5).
 *   2. Fetch original file from storage.
 *   3. Run extractors per the order above.
 *   4. Store raw text in object storage.
 *   5. Insert document_extractions row (append-only, §4.1).
 *   6. Compare-and-set documents.status → 'text_extracted'.
 *   7. Append an audit event.
 *
 * Idempotency: queue redelivers are absorbed by the compare-and-set on
 * step 1 — only `received` / `processing` are claimable. Older statuses
 * silently no-op.
 */
import { randomUUID } from "node:crypto";
import type PgBoss from "pg-boss";
import { and, eq, inArray } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import { documents, documentExtractions, auditEvents } from "@/db/schema";
import { storage, rawTextStorageKey } from "@/lib/storage";
import {
  nativePdfExtractor,
  tesseractExtractor,
  tesseractPdfExtractor,
  type ExtractionResult,
} from "@/lib/ocr";
import { LOW_QUALITY_THRESHOLD, LOW_TEXT_LENGTH } from "@/lib/ocr/text-quality";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

export async function handleProcessDocument(
  job: PgBoss.Job<JobPayloads[typeof JOB.processDocument]>,
): Promise<void> {
  const { documentId, organizationId } = job.data;

  // ── 1. Load doc + compare-and-set status ──────────────────────────────
  const doc = await withOrgAsWorker(organizationId, async (tx) => {
    // Compare-and-set: only move forward from 'received' or 'processing'
    // (§4.5). Returning the row only when the update succeeds guarantees
    // a duplicate delivery sees an empty result and bails.
    const claimed = await tx
      .update(documents)
      .set({ status: "processing" })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, organizationId),
          inArray(documents.status, ["received", "processing"]),
        ),
      )
      .returning({
        id: documents.id,
        mimeType: documents.mimeType,
        storageKey: documents.storageKey,
      });
    return claimed[0] ?? null;
  });

  if (!doc) {
    console.log(
      `[process-document] doc=${documentId} not claimable (already past 'processing'); skipping`,
    );
    return;
  }

  // ── 2. Fetch original bytes ──────────────────────────────────────────
  const bytes = await storage.getObject(doc.storageKey);
  const mimeType = doc.mimeType ?? "application/octet-stream";

  // ── 3. Run extractors ────────────────────────────────────────────────
  let result = await runExtractionPipeline(mimeType, bytes);

  if (!result) {
    // No extractor accepts this MIME — should not happen given §2.6 sniff,
    // but fail loudly rather than silently mark the doc 'text_extracted'.
    await markFailed(organizationId, documentId, `no extractor for MIME '${mimeType}'`);
    throw new Error(`no extractor for MIME '${mimeType}'`);
  }

  // ── 4. Write raw text to object storage ──────────────────────────────
  // We mint the extraction UUID up-front so the storage key is stable
  // before the DB row exists.
  const extractionId = randomUUID();
  const textKey = rawTextStorageKey({
    organizationId,
    documentId,
    extractionId,
  });
  await storage.putObject({
    key: textKey,
    body: Buffer.from(result.text, "utf8"),
    contentType: "text/plain; charset=utf-8",
  });

  // ── 5. Append extraction row + advance document status ───────────────
  const warnings: string[] = [];
  if (result.qualityScore < LOW_QUALITY_THRESHOLD)
    warnings.push("low_quality_text");
  if (result.text.length < LOW_TEXT_LENGTH) warnings.push("low_text_length");
  // Surface rasterize failures so the review queue knows why a PDF lacks text.
  const rasterizeError = (result.metadata as { rasterizeError?: string })
    ?.rasterizeError;
  if (rasterizeError) warnings.push(`rasterize:${rasterizeError}`);

  await withOrgAsWorker(organizationId, async (tx) => {
    await tx.insert(documentExtractions).values({
      id: extractionId,
      organizationId,
      documentId,
      method: result.method,
      provider: result.provider,
      rawTextStorageKey: textKey,
      textLength: result.text.length,
      qualityScore: String(result.qualityScore),
      averageConfidence:
        result.averageConfidence === null
          ? null
          : String(result.averageConfidence),
      metadataJson: {
        ...result.metadata,
        warnings,
      },
    });

    // Compare-and-set: only advance from 'processing'.
    await tx
      .update(documents)
      .set({ status: "text_extracted" })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, organizationId),
          eq(documents.status, "processing"),
        ),
      );

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "document.text_extracted",
      entityType: "document",
      entityId: documentId,
      metadataJson: {
        method: result.method,
        textLength: result.text.length,
        qualityScore: result.qualityScore,
        warnings,
      },
    });
  });

  // Phase 3 will enqueue 'extract-invoice-data' here. For Phase 2 we stop.
}

async function markFailed(
  organizationId: string,
  documentId: string,
  reason: string,
) {
  await withOrgAsWorker(organizationId, async (tx) => {
    await tx
      .update(documents)
      .set({ status: "failed" })
      .where(eq(documents.id, documentId));
    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "document.failed",
      entityType: "document",
      entityId: documentId,
      metadataJson: { reason },
    });
  });
}

/**
 * Extraction routing.
 *
 *   PDF  → native pdf-parse → if quality < threshold, also run
 *          tesseract_pdf → pick whichever scored higher. Both attempts
 *          are visible to the caller via the chosen result's metadata.
 *   IMG  → tesseract_image (single attempt).
 *
 * We return ExtractionResult instead of "best of N" so the caller stays
 * dumb. Callers see one result and store one row.
 */
async function runExtractionPipeline(
  mimeType: string,
  bytes: Buffer,
): Promise<ExtractionResult | null> {
  if (mimeType === "application/pdf") {
    const native = await nativePdfExtractor.extract({ mimeType, bytes });
    if (native && native.qualityScore >= LOW_QUALITY_THRESHOLD) {
      return native;
    }
    // Native didn't yield usable text — try OCR. Even if rasterization
    // fails internally, tesseractPdfExtractor returns a structured result
    // with the reason, which we surface as a warning.
    const ocr = await tesseractPdfExtractor.extract({ mimeType, bytes });
    if (!native) return ocr; // shouldn't happen, but safe.
    if (!ocr) return native;
    // Pick the better of the two.
    return ocr.qualityScore > native.qualityScore ? ocr : native;
  }

  return tesseractExtractor.extract({ mimeType, bytes });
}

