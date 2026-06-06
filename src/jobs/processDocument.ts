/**
 * process-document — PRD §"Job: Process Document".
 *
 * Steps:
 *   1. Load document row (worker scope, RLS-enforced via withOrgAsWorker).
 *   2. Compare-and-set status to 'processing' (§4.5 — silent skip if lost).
 *   3. Fetch original file from storage.
 *   4. Native PDF extraction first.
 *   5. If PDF text scored poorly: log a warning. (PDF→OCR rasterization
 *      is a Phase 2.1 add — see tesseract.ts for the gap.)
 *   6. If input is an image: Tesseract.
 *   7. Store raw text in object storage.
 *   8. Insert document_extractions row (append-only, §4.1).
 *   9. Compare-and-set documents.status → 'text_extracted'.
 *  10. Append an audit event.
 *
 * Idempotency: the job is keyed on document_id (queue-level retry). Step 2's
 * compare-and-set means a duplicate delivery either:
 *   (a) sees status='received' and proceeds (legitimate retry), or
 *   (b) sees status not in (received, processing) and aborts silently.
 * Either way, no duplicate extractions are stored — the OCR work may run
 * twice on a crash, but the latest-by-created_at reader picks one row.
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
  scoreText,
  type ExtractionResult,
} from "@/lib/ocr";
import { LOW_QUALITY_THRESHOLD, LOW_TEXT_LENGTH } from "@/lib/ocr/text-quality";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

const EXTRACTORS = [nativePdfExtractor, tesseractExtractor];

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

  // ── 3. Run extractors until one yields text ──────────────────────────
  let result: ExtractionResult | null = null;
  for (const extractor of EXTRACTORS) {
    result = await extractor.extract({ mimeType, bytes });
    if (result) break;
  }

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
  // Phase 2 gap: low-quality PDFs need rasterize→tesseract; flagged for
  // review until Phase 2.1 wires poppler.
  if (mimeType === "application/pdf" && result.qualityScore < LOW_QUALITY_THRESHOLD)
    warnings.push("pdf_ocr_fallback_pending");

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

