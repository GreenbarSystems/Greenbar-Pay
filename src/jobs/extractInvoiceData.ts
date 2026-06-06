/**
 * extract-invoice-data — PRD §"Job: Extract Invoice Data".
 *
 * Trigger: `document.text_extracted` (enqueued by process-document).
 *
 * Steps:
 *   1. Load doc + latest extraction; ensure status='text_extracted'.
 *   2. Pre-flight: if the doc is already approved/rejected/exported,
 *      a retry of this job must NOT supersede the reviewer's decision
 *      (§4.2). Bail with a structured error.
 *   3. Read raw text from object storage.
 *   4. Dispatch through the gateway. Every outcome lands an llm_runs row.
 *   5. On success: supersede any pending/needs_review extracted_invoices
 *      row for this document, insert the new header + lines (§4.2).
 *   6. Advance documents.status to 'llm_extracted' via compare-and-set.
 *   7. Audit event.
 *
 * Phase 4 (validation) will pick up from `llm_extracted` and move docs
 * to `review_required`. For Phase 3 we stop after llm_extracted.
 */
import type PgBoss from "pg-boss";
import { and, eq, inArray, desc } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import {
  documents,
  documentExtractions,
  llmRuns,
  extractedInvoices,
  extractedInvoiceLines,
  auditEvents,
} from "@/db/schema";
import { storage } from "@/lib/storage";
import {
  dispatchInvoiceExtraction,
  MAX_INPUT_CHARS,
  type DispatchOutcome,
} from "@/lib/llm";
import { scrub } from "@/lib/llm/scrub";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

export async function handleExtractInvoiceData(
  job: PgBoss.Job<JobPayloads[typeof JOB.extractInvoiceData]>,
): Promise<void> {
  const { documentId, organizationId } = job.data;

  // ── 1. Load doc + latest extraction + guard against reviewer race ────
  const setup = await withOrgAsWorker(organizationId, async (tx) => {
    const doc = await tx.query.documents.findFirst({
      where: (d, { and, eq }) =>
        and(eq(d.id, documentId), eq(d.organizationId, organizationId)),
      columns: { id: true, status: true, mimeType: true, pageCount: true },
    });
    if (!doc) return { kind: "missing_doc" as const };

    // §4.2 — reviewer race guard: if any active row for this doc is
    // approved/rejected/exported, an upstream retry is rejected.
    const reviewed = await tx
      .select({ id: extractedInvoices.id, reviewStatus: extractedInvoices.reviewStatus })
      .from(extractedInvoices)
      .where(
        and(
          eq(extractedInvoices.documentId, documentId),
          inArray(extractedInvoices.reviewStatus, [
            "approved",
            "rejected",
            "exported",
          ]),
        ),
      )
      .limit(1);
    if (reviewed[0]) {
      return {
        kind: "already_reviewed" as const,
        reviewStatus: reviewed[0].reviewStatus,
      };
    }

    const latest = await tx
      .select({
        rawTextStorageKey: documentExtractions.rawTextStorageKey,
        textLength: documentExtractions.textLength,
      })
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, documentId))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(1);

    if (!latest[0]) return { kind: "no_extraction" as const };

    return {
      kind: "ready" as const,
      doc,
      extraction: latest[0],
    };
  });

  if (setup.kind === "missing_doc") {
    console.warn(`[extract-invoice-data] doc=${documentId} missing; skipping`);
    return;
  }
  if (setup.kind === "no_extraction") {
    throw new Error(`no document_extractions row for ${documentId}`);
  }
  if (setup.kind === "already_reviewed") {
    // Hard error so the queue retry policy stops trying. The reviewer
    // has acted — we don't get to re-extract.
    const err = new Error(
      `document ${documentId} already ${setup.reviewStatus}; refusing to supersede`,
    );
    (err as { code?: string }).code = "already_reviewed";
    throw err;
  }

  const { doc, extraction } = setup;

  // ── 2. Load raw text ──────────────────────────────────────────────────
  const textBuf = await storage.getObject(extraction.rawTextStorageKey);
  const documentText = textBuf.toString("utf8");

  // Mime + pages from doc row, not extraction metadata, so the prompt
  // can describe completeness.
  const mimeType = doc.mimeType ?? "application/octet-stream";
  const pageCount = doc.pageCount ?? null;

  // ── 3. Dispatch ───────────────────────────────────────────────────────
  const outcome = await dispatchInvoiceExtraction({
    organizationId,
    documentText,
    mimeType,
    pageCount,
  });

  // ── 4. Persist outcome ────────────────────────────────────────────────
  await persistOutcome(organizationId, documentId, outcome, documentText.length);
}

async function persistOutcome(
  organizationId: string,
  documentId: string,
  outcome: DispatchOutcome,
  charCount: number,
): Promise<void> {
  await withOrgAsWorker(organizationId, async (tx) => {
    const meta = outcome.meta;

    // Common llm_runs row fields.
    const runStatus = mapOutcomeToRunStatus(outcome);
    const errorMessage =
      outcome.kind === "schema_failed"
        ? "schema validation failed after retry"
        : outcome.kind === "provider_error"
          ? outcome.error.message
          : outcome.kind === "non_compliant_model"
            ? outcome.error.message
            : outcome.kind === "text_too_large"
              ? `input ${charCount} chars exceeds max ${MAX_INPUT_CHARS}`
              : outcome.kind === "quota_exceeded"
                ? "daily quota exhausted"
                : outcome.kind === "circuit_open"
                  ? "provider circuit open"
                  : null;

    const [run] = await tx
      .insert(llmRuns)
      .values({
        organizationId,
        documentId,
        provider: meta.modelId.split(":")[0],
        model: meta.modelId,
        promptName: meta.promptName,
        promptVersion: meta.promptVersion,
        inputHash: "inputHash" in meta ? meta.inputHash : null,
        inputTokensEstimate:
          "inputTokensEstimate" in meta ? meta.inputTokensEstimate : null,
        outputJson: outcome.kind === "succeeded" ? outcome.result : null,
        status: runStatus,
        errorMessage,
        durationMs: "durationMs" in meta ? meta.durationMs : null,
      })
      .returning({ id: llmRuns.id });

    // Successful extraction: supersede + insert + advance status.
    if (outcome.kind === "succeeded") {
      // §4.2 supersede.
      await tx
        .update(extractedInvoices)
        .set({ reviewStatus: "superseded", updatedAt: new Date() })
        .where(
          and(
            eq(extractedInvoices.documentId, documentId),
            inArray(extractedInvoices.reviewStatus, ["pending", "needs_review"]),
          ),
        );

      const r = outcome.result;
      const [inserted] = await tx
        .insert(extractedInvoices)
        .values({
          organizationId,
          documentId,
          llmRunId: run.id,
          documentType: r.documentType,
          vendorName: r.vendorName,
          vendorAddress: r.vendorAddress,
          remitToName: r.remitToName,
          remitToAddress: r.remitToAddress,
          invoiceNumber: r.invoiceNumber,
          invoiceDate: r.invoiceDate,
          dueDate: r.dueDate,
          paymentTerms: r.paymentTerms,
          purchaseOrderNumber: r.purchaseOrderNumber,
          currency: r.currency ?? "USD",
          subtotal: r.subtotal === null ? null : String(r.subtotal),
          tax: r.tax === null ? null : String(r.tax),
          shipping: r.shipping === null ? null : String(r.shipping),
          discount: r.discount === null ? null : String(r.discount),
          total: r.total === null ? null : String(r.total),
          confidence: r.confidence,
          warningsJson: r.warnings,
        })
        .returning({ id: extractedInvoices.id });

      if (r.lineItems.length > 0) {
        await tx.insert(extractedInvoiceLines).values(
          r.lineItems.map((li, idx) => ({
            organizationId,
            extractedInvoiceId: inserted.id,
            lineNumber: idx + 1,
            description: li.description,
            quantity: li.quantity === null ? null : String(li.quantity),
            unitPrice: li.unitPrice === null ? null : String(li.unitPrice),
            amount: li.amount === null ? null : String(li.amount),
          })),
        );
      }

      await tx
        .update(documents)
        .set({ status: "llm_extracted" })
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.status, "text_extracted"),
          ),
        );

      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "worker",
        action: "document.llm_extracted",
        entityType: "document",
        entityId: documentId,
        metadataJson: scrub({
          llmRunId: run.id,
          extractedInvoiceId: inserted.id,
          confidence: r.confidence,
          lineCount: r.lineItems.length,
          warningCount: r.warnings.length,
        }),
      });
      return;
    }

    // Non-success: mark the document review_required if pre-flight failed
    // before the dispatch even left the gateway. Otherwise mark failed —
    // operators will replay from the llm_runs row.
    const newStatus =
      outcome.kind === "text_too_large" ||
      outcome.kind === "quota_exceeded" ||
      outcome.kind === "circuit_open"
        ? "review_required"
        : "failed";

    await tx
      .update(documents)
      .set({ status: newStatus })
      .where(
        and(
          eq(documents.id, documentId),
          inArray(documents.status, [
            "text_extracted",
            "processing",
            "received",
          ]),
        ),
      );

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: `document.${runStatus}`,
      entityType: "document",
      entityId: documentId,
      metadataJson: {
        llmRunId: run.id,
        runStatus,
        // Error message is already scrubbed via the outcome path.
        // No payload here.
      },
    });
  });
}

function mapOutcomeToRunStatus(
  outcome: DispatchOutcome,
): "succeeded" | "schema_failed" | "provider_error" | "text_too_large" | "quota_exceeded" | "circuit_open" {
  switch (outcome.kind) {
    case "succeeded":
      return "succeeded";
    case "schema_failed":
      return "schema_failed";
    case "provider_error":
      return "provider_error";
    case "text_too_large":
      return "text_too_large";
    case "quota_exceeded":
      return "quota_exceeded";
    case "circuit_open":
      return "circuit_open";
    case "non_compliant_model":
      return "provider_error";
  }
}
