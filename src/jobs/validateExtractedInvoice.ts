/**
 * validate-extracted-invoice — PRD §"Job: Validate Extracted Invoice".
 *
 * Trigger: enqueued by extract-invoice-data after a successful LLM run.
 *
 * Steps:
 *   1. Load doc + active extracted invoice.
 *   2. Run validation (delegates to runValidationInTx so the PATCH
 *      endpoint can re-use the exact same logic).
 *   3. Update extracted_invoices.review_status:
 *        blocking findings → 'needs_review'
 *        else              → 'pending'
 *      (per addendum §4.2 only pending/needs_review rows can be acted on.)
 *   4. Compare-and-set documents.status to 'review_required' from
 *      'llm_extracted' (§4.5).
 *   5. Audit event.
 */
import type PgBoss from "pg-boss";
import { and, eq, inArray } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import {
  documents,
  extractedInvoices,
  auditEvents,
} from "@/db/schema";
import { runValidationInTx } from "@/lib/validation/run";
import { blockingPresent } from "@/lib/validation";
import type { JobPayloads } from "@/lib/queue";
import { JOB, getQueue } from "@/lib/queue";

export async function handleValidateExtractedInvoice(
  job: PgBoss.Job<JobPayloads[typeof JOB.validateExtractedInvoice]>,
): Promise<void> {
  const { extractedInvoiceId, organizationId } = job.data;

  await withOrgAsWorker(organizationId, async (tx) => {
    const [row] = await tx
      .select({
        id: extractedInvoices.id,
        documentId: extractedInvoices.documentId,
        reviewStatus: extractedInvoices.reviewStatus,
      })
      .from(extractedInvoices)
      .where(
        and(
          eq(extractedInvoices.id, extractedInvoiceId),
          eq(extractedInvoices.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) return; // Retry of a row that was superseded; skip silently.
    if (!isActiveForValidation(row.reviewStatus)) return;

    const out = await runValidationInTx(tx, {
      organizationId,
      extractedInvoiceId: row.id,
      documentId: row.documentId,
    });

    await tx
      .update(extractedInvoices)
      .set({
        reviewStatus: out.newReviewStatus,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(extractedInvoices.id, row.id),
          // Only mutate while still in a validator-owned state.
          inArray(extractedInvoices.reviewStatus, ["pending", "needs_review"]),
        ),
      );

    await tx
      .update(documents)
      .set({ status: "review_required" })
      .where(
        and(
          eq(documents.id, row.documentId),
          inArray(documents.status, ["llm_extracted", "review_required"]),
        ),
      );

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "invoice.validated",
      entityType: "extracted_invoice",
      entityId: row.id,
      metadataJson: {
        newReviewStatus: out.newReviewStatus,
        findingCount: out.findings.length,
        blocking: blockingPresent(out.findings),
        vendorMatch: out.vendorMatch,
      },
    });
  });

  // Phase 8 — D2: refresh the Briefing Card after every validation run.
  // The job is idempotent on extractedInvoiceId and advisory-locked,
  // so a duplicate delivery (e.g. PATCH re-validate followed by a job
  // retry) collapses to one fresh briefing.
  const boss = await getQueue();
  await boss.send(
    JOB.generateBriefingCard,
    { extractedInvoiceId, organizationId },
    { singletonKey: `generate-briefing-card:${extractedInvoiceId}` },
  );
}

function isActiveForValidation(status: string): boolean {
  return status === "pending" || status === "needs_review";
}
