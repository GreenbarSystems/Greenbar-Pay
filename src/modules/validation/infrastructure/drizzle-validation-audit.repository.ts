/**
 * ValidationAuditRepository implementation. Moved verbatim from
 * src/lib/validation/run.ts (line_confidence.recalculated,
 * validation.contract_scored) and src/jobs/validateExtractedInvoice.ts
 * (invoice.validated).
 */
import type { Tx } from "@/db/client";
import { auditEvents } from "@/db/schema";
import type { ValidationAuditRepository } from "../application/ports";

async function recordLineConfidenceRecalculated(
  tx: Tx,
  args: Parameters<ValidationAuditRepository["recordLineConfidenceRecalculated"]>[1],
): Promise<void> {
  // PR12 C4 — a bare in-place UPDATE used to silently destroy the
  // evidence that supported any previously active briefing card. This
  // emits one audit event carrying the before/after snapshot whenever
  // at least one line's confidence numbers actually changed.
  await tx.insert(auditEvents).values({
    organizationId: args.organizationId,
    actorType: "worker",
    action: "line_confidence.recalculated",
    entityType: "extracted_invoice",
    entityId: args.extractedInvoiceId,
    metadataJson: { changes: args.changes },
  });
}

async function recordContractScored(
  tx: Tx,
  args: Parameters<ValidationAuditRepository["recordContractScored"]>[1],
): Promise<void> {
  await tx.insert(auditEvents).values({
    organizationId: args.organizationId,
    actorType: "worker",
    action: "validation.contract_scored",
    entityType: "extracted_invoice",
    entityId: args.extractedInvoiceId,
    metadataJson: {
      contractId: args.contractId,
      contractedLineNumbers: args.contractedLineNumbers,
      contractFindingCount: args.contractFindingCount,
      contractFindingCodes: args.contractFindingCodes,
      // PR21 H2 — binds this event to the exact rate-card content used.
      contractRateCardHash: args.contractRateCardHash,
    },
  });
}

async function recordInvoiceValidated(
  tx: Tx,
  args: Parameters<ValidationAuditRepository["recordInvoiceValidated"]>[1],
): Promise<void> {
  await tx.insert(auditEvents).values({
    organizationId: args.organizationId,
    actorType: "worker",
    action: "invoice.validated",
    entityType: "extracted_invoice",
    entityId: args.extractedInvoiceId,
    metadataJson: {
      newReviewStatus: args.newReviewStatus,
      findingCount: args.findingCount,
      blocking: args.blocking,
      vendorMatch: args.vendorMatch,
    },
  });
}

export const drizzleValidationAuditRepository: ValidationAuditRepository = {
  recordLineConfidenceRecalculated,
  recordContractScored,
  recordInvoiceValidated,
};
