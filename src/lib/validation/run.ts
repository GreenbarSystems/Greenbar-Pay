/**
 * Shared validation runner. Called from:
 *   - validate-extracted-invoice job (post-LLM-extraction)
 *   - PATCH /api/ap/review/:id (after a reviewer edits a field)
 *
 * Owns the DB I/O around the pure `validateInvoice()` engine:
 *   - load extracted invoice + lines + latest extraction text length;
 *   - load prior-approved (vendor, invoice_number) pairs for duplicate check;
 *   - load vendor candidates and run matchVendor();
 *   - SOFT-supersede prior validation_results (UPDATE … SET superseded_at)
 *     so the evidence chain stays intact (PR2);
 *   - insert fresh rows.
 *
 * Returns the findings so the caller can decide review_status transitions.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  extractedInvoices,
  extractedInvoiceLines,
  documentExtractions,
  vendors,
  vendorMatches,
  validationResults,
} from "@/db/schema";
import { desc } from "drizzle-orm";
import {
  validateInvoice,
  blockingPresent,
  duplicateKey,
  type ValidationFinding,
} from ".";
import { matchVendor } from "./vendor-match";

export interface RunValidationResult {
  findings: ValidationFinding[];
  newReviewStatus: "pending" | "needs_review";
  vendorMatch: {
    vendorId: string | null;
    confidence: "low" | "medium" | "high";
    score: number;
  } | null;
}

/**
 * Runs all validation for a single (already-loaded-in-tx) extracted
 * invoice. Caller controls the transaction so we can compose with edits.
 */
export async function runValidationInTx(
  tx: Tx,
  args: {
    organizationId: string;
    extractedInvoiceId: string;
    documentId: string;
  },
): Promise<RunValidationResult> {
  // 1. Load the invoice + lines.
  const [invoice] = await tx
    .select()
    .from(extractedInvoices)
    .where(
      and(
        eq(extractedInvoices.id, args.extractedInvoiceId),
        eq(extractedInvoices.organizationId, args.organizationId),
      ),
    )
    .limit(1);
  if (!invoice) throw new Error(`invoice ${args.extractedInvoiceId} not found`);

  const lines = await tx
    .select()
    .from(extractedInvoiceLines)
    .where(eq(extractedInvoiceLines.extractedInvoiceId, args.extractedInvoiceId));

  // 2. Prior approved/exported (vendor, invoice_number) pairs for dedup.
  //
  // We select id explicitly so the self-exclusion filter below actually
  // compares uuid-to-uuid. The earlier version omitted id from the
  // projection, making `r.id !== args.extractedInvoiceId` an
  // `undefined !== uuid` test that always passed.
  const priorRows = await tx
    .select({
      id: extractedInvoices.id,
      vendorName: extractedInvoices.vendorName,
      invoiceNumber: extractedInvoices.invoiceNumber,
    })
    .from(extractedInvoices)
    .where(
      and(
        eq(extractedInvoices.organizationId, args.organizationId),
        inArray(extractedInvoices.reviewStatus, ["approved", "exported"]),
      ),
    );
  const priorApprovedKeys = new Set(
    priorRows
      .filter((r) => r.vendorName && r.invoiceNumber && r.id !== args.extractedInvoiceId)
      .map((r) => duplicateKey(r.vendorName!, r.invoiceNumber!)),
  );

  // 3. Vendor match.
  const candidates = await tx
    .select({
      id: vendors.id,
      name: vendors.name,
      normalizedName: vendors.normalizedName,
    })
    .from(vendors)
    .where(eq(vendors.organizationId, args.organizationId));
  const vm = matchVendor(invoice.vendorName, candidates);

  // 4. Latest extraction text length.
  const [latestExtraction] = await tx
    .select({ textLength: documentExtractions.textLength })
    .from(documentExtractions)
    .where(eq(documentExtractions.documentId, args.documentId))
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);

  // 5. Run the pure validator.
  const findings = validateInvoice({
    invoice: {
      documentType: invoice.documentType,
      vendorName: invoice.vendorName,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      subtotal: invoice.subtotal === null ? null : Number(invoice.subtotal),
      tax: invoice.tax === null ? null : Number(invoice.tax),
      shipping: invoice.shipping === null ? null : Number(invoice.shipping),
      discount: invoice.discount === null ? null : Number(invoice.discount),
      total: invoice.total === null ? null : Number(invoice.total),
      lineItems: lines,
    },
    priorApprovedKeys,
    vendorMatch: vm.vendorId
      ? { confidence: vm.confidence, score: vm.score }
      : null,
    textLength: latestExtraction?.textLength ?? null,
  });

  // 6. Persist — soft-supersede prior active row(s), then insert fresh.
  //    PR2: hard DELETE destroyed prior-blocking evidence (review #4).
  //    The active view is WHERE superseded_at IS NULL (indexed).
  await tx
    .update(validationResults)
    .set({ supersededAt: sql`now()` })
    .where(
      and(
        eq(validationResults.entityType, "extracted_invoice"),
        eq(validationResults.entityId, args.extractedInvoiceId),
        isNull(validationResults.supersededAt),
      ),
    );

  if (findings.length > 0) {
    const hasBlocking = blockingPresent(findings);
    await tx.insert(validationResults).values({
      organizationId: args.organizationId,
      entityType: "extracted_invoice",
      entityId: args.extractedInvoiceId,
      passed: !hasBlocking,
      severity: hasBlocking ? "blocking" : "warning",
      errorsJson: findings,
    });
  } else {
    await tx.insert(validationResults).values({
      organizationId: args.organizationId,
      entityType: "extracted_invoice",
      entityId: args.extractedInvoiceId,
      passed: true,
      severity: "warning", // placeholder; column is NOT NULL
      errorsJson: [],
    });
  }

  // 7. Vendor match row (append-only — keeps the candidate history visible).
  await tx.insert(vendorMatches).values({
    organizationId: args.organizationId,
    extractedInvoiceId: args.extractedInvoiceId,
    vendorId: vm.vendorId,
    matchConfidence: vm.confidence,
    matchScore: String(vm.score),
    candidatesJson: vm.candidates,
  });

  return {
    findings,
    newReviewStatus: blockingPresent(findings) ? "needs_review" : "pending",
    vendorMatch: {
      vendorId: vm.vendorId,
      confidence: vm.confidence,
      score: vm.score,
    },
  };
}
