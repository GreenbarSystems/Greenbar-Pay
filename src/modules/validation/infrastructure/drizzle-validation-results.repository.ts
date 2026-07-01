/**
 * ValidationResultsRepository implementation. Moved verbatim from
 * src/lib/validation/run.ts — PR2's soft-supersede pattern: the active
 * view is WHERE superseded_at IS NULL, never a hard DELETE, so the
 * evidence chain survives a reviewer's edit clearing a prior finding.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { validationResults } from "@/db/schema";
import type { ValidationResultInput, ValidationResultsRepository } from "../application/ports";

async function supersedeActive(tx: Tx, extractedInvoiceId: string): Promise<void> {
  await tx
    .update(validationResults)
    .set({ supersededAt: sql`now()` })
    .where(
      and(
        eq(validationResults.entityType, "extracted_invoice"),
        eq(validationResults.entityId, extractedInvoiceId),
        isNull(validationResults.supersededAt),
      ),
    );
}

async function insert(tx: Tx, result: ValidationResultInput): Promise<void> {
  await tx.insert(validationResults).values({
    organizationId: result.organizationId,
    entityType: "extracted_invoice",
    entityId: result.extractedInvoiceId,
    passed: result.passed,
    severity: result.severity,
    errorsJson: result.errorsJson,
  });
}

export const drizzleValidationResultsRepository: ValidationResultsRepository = {
  supersedeActive,
  insert,
};
