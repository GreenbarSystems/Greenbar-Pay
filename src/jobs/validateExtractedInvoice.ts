/**
 * validate-extracted-invoice — PRD §"Job: Validate Extracted Invoice".
 *
 * Trigger: enqueued by extract-invoice-data after a successful LLM run.
 * All business logic (loading the row, running validation, updating
 * review_status/document status, the invoice.validated audit event)
 * lives in
 * src/modules/validation/application/use-cases/validate-extracted-invoice.usecase.ts
 * — this file is just the pg-boss adapter: unwrap the payload, open the
 * worker transaction, call the use case, then enqueue the briefing-card
 * refresh (a queue side-effect left at the job boundary, same as every
 * other job in this codebase).
 */
import type PgBoss from "pg-boss";
import { withOrgAsWorker } from "@/db/client";
import type { JobPayloads } from "@/lib/queue";
import { JOB, getQueue } from "@/lib/queue";
import { validateExtractedInvoiceJob, validationModule } from "@/modules/validation";

export async function handleValidateExtractedInvoice(
  job: PgBoss.Job<JobPayloads[typeof JOB.validateExtractedInvoice]>,
): Promise<void> {
  const { extractedInvoiceId, organizationId } = job.data;

  await withOrgAsWorker(organizationId, (tx) =>
    validateExtractedInvoiceJob(tx, validationModule, {
      extractedInvoiceId,
      organizationId,
    }),
  );

  // Phase 8 — D2: refresh the Briefing Card after every validation run.
  // The job is idempotent on extractedInvoiceId and advisory-locked,
  // so a duplicate delivery (e.g. PATCH re-validate followed by a job
  // retry) collapses to one fresh briefing. Wrapped in try/catch so a
  // transient pg-boss outage doesn't fail the validation job itself —
  // the validate committed; a missed briefing is recoverable.
  try {
    const boss = await getQueue();
    await boss.send(
      JOB.generateBriefingCard,
      { extractedInvoiceId, organizationId },
      { singletonKey: `generate-briefing-card:${extractedInvoiceId}` },
    );
  } catch (err) {
    console.warn(
      `[validate-extracted-invoice] generateBriefingCard enqueue failed for invoice=${extractedInvoiceId}; validation committed, briefing card will be skipped`,
      err,
    );
  }
}
