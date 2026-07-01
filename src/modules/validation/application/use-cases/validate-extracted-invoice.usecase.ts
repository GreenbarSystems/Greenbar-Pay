/**
 * Use case: validate-extracted-invoice job body. Moved out of
 * src/jobs/validateExtractedInvoice.ts, which is now a thin pg-boss
 * adapter: unwrap the payload, open the worker transaction, call this,
 * then enqueue generate-briefing-card (a queue side-effect left at the
 * job boundary, same as every other job in this codebase).
 */
import type { Tx } from "@/db/client";
import { blockingPresent } from "../../domain/engine";
import { runInvoiceValidation, type RunInvoiceValidationDeps } from "./run-invoice-validation.usecase";

export interface ValidateExtractedInvoiceArgs {
  organizationId: string;
  extractedInvoiceId: string;
}

const ACTIVE_FOR_VALIDATION = ["pending", "needs_review"] as const;

function isActiveForValidation(status: string): boolean {
  return status === "pending" || status === "needs_review";
}

export async function validateExtractedInvoiceJob(
  tx: Tx,
  deps: RunInvoiceValidationDeps,
  args: ValidateExtractedInvoiceArgs,
): Promise<void> {
  const row = await deps.invoiceRepository.findStatusForValidation(
    tx,
    args.organizationId,
    args.extractedInvoiceId,
  );
  if (!row) return; // Retry of a row that was superseded; skip silently.
  if (!isActiveForValidation(row.reviewStatus)) return;

  const out = await runInvoiceValidation(tx, deps, {
    organizationId: args.organizationId,
    extractedInvoiceId: row.id,
    documentId: row.documentId,
  });

  // Only mutate while still in a validator-owned state.
  await deps.invoiceRepository.updateReviewStatusIfActive(
    tx,
    row.id,
    out.newReviewStatus,
    [...ACTIVE_FOR_VALIDATION],
  );

  await deps.documentRepository.updateStatusIfIn(
    tx,
    row.documentId,
    "review_required",
    ["llm_extracted", "review_required"],
  );

  await deps.auditRepository.recordInvoiceValidated(tx, {
    organizationId: args.organizationId,
    extractedInvoiceId: row.id,
    newReviewStatus: out.newReviewStatus,
    findingCount: out.findings.length,
    blocking: blockingPresent(out.findings),
    vendorMatch: out.vendorMatch,
  });
}
