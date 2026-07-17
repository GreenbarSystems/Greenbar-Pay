/**
 * InvoiceRepository implementation. Every query here is moved verbatim
 * from src/lib/validation/run.ts and src/jobs/validateExtractedInvoice.ts.
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { extractedInvoiceLines, extractedInvoices } from "@/db/schema";
import { duplicateKey } from "../domain/engine";
import type { RemitToInfo } from "../domain/remit-drift";
import type {
  InvoiceHeaderForValidation,
  InvoiceLineForValidation,
  InvoiceRepository,
  InvoiceStatusForValidation,
  LineConfidenceSnapshot,
  LineConfidenceUpdate,
} from "../application/ports";

async function lockForValidation(tx: Tx, extractedInvoiceId: string): Promise<void> {
  // hashtextextended takes a bigint salt; 0 is fine since the key space
  // is per-entity-UUID and collisions across invoices only mean
  // serialization, never correctness loss.
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended('validation:' || ${extractedInvoiceId}::text, 0)
    )
  `);
}

async function findForValidation(
  tx: Tx,
  organizationId: string,
  extractedInvoiceId: string,
): Promise<{ invoice: InvoiceHeaderForValidation; lines: InvoiceLineForValidation[] } | null> {
  const [invoice] = await tx
    .select({
      documentType: extractedInvoices.documentType,
      vendorName: extractedInvoices.vendorName,
      invoiceNumber: extractedInvoices.invoiceNumber,
      invoiceDate: extractedInvoices.invoiceDate,
      dueDate: extractedInvoices.dueDate,
      currency: extractedInvoices.currency,
      subtotal: extractedInvoices.subtotal,
      tax: extractedInvoices.tax,
      shipping: extractedInvoices.shipping,
      discount: extractedInvoices.discount,
      total: extractedInvoices.total,
      remitToName: extractedInvoices.remitToName,
      remitToAddress: extractedInvoices.remitToAddress,
      purchaseOrderNumber: extractedInvoices.purchaseOrderNumber,
    })
    .from(extractedInvoices)
    .where(
      and(
        eq(extractedInvoices.id, extractedInvoiceId),
        eq(extractedInvoices.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!invoice) return null;

  // Only the fields the two scoring passes + validateInvoice()'s
  // `lineItems.length` check actually use — validateInvoice never reads
  // any other line column, so narrowing here is behavior-identical.
  const lines = await tx
    .select({
      id: extractedInvoiceLines.id,
      lineNumber: extractedInvoiceLines.lineNumber,
      description: extractedInvoiceLines.description,
      unitPrice: extractedInvoiceLines.unitPrice,
    })
    .from(extractedInvoiceLines)
    .where(eq(extractedInvoiceLines.extractedInvoiceId, extractedInvoiceId));

  return { invoice, lines };
}

async function findPriorApprovedKeys(
  tx: Tx,
  organizationId: string,
  excludeInvoiceId: string,
): Promise<Set<string>> {
  const priorRows = await tx
    .select({
      id: extractedInvoices.id,
      vendorName: extractedInvoices.vendorName,
      invoiceNumber: extractedInvoices.invoiceNumber,
    })
    .from(extractedInvoices)
    .where(
      and(
        eq(extractedInvoices.organizationId, organizationId),
        inArray(extractedInvoices.reviewStatus, ["approved", "exported"]),
      ),
    );
  return new Set(
    priorRows
      .filter((r) => r.vendorName && r.invoiceNumber && r.id !== excludeInvoiceId)
      .map((r) => duplicateKey(r.vendorName!, r.invoiceNumber!)),
  );
}

/**
 * 2026-07-13 audit F7 — matched the same way F06's vendor-pricing
 * lookup and the vendors module's history query are: normalize_vendor_text()
 * so the functional index is used, restricted to approved/exported so a
 * still-pending or rejected invoice never becomes the drift baseline.
 * Ordered by reviewedAt (system-observed) rather than the extracted
 * invoiceDate, since invoiceDate is attacker-influenced input.
 */
async function findLatestApprovedRemitTo(
  tx: Tx,
  organizationId: string,
  vendorName: string,
  excludeInvoiceId: string,
): Promise<RemitToInfo | null> {
  const [row] = await tx
    .select({
      remitToName: extractedInvoices.remitToName,
      remitToAddress: extractedInvoices.remitToAddress,
    })
    .from(extractedInvoices)
    .where(
      and(
        eq(extractedInvoices.organizationId, organizationId),
        inArray(extractedInvoices.reviewStatus, ["approved", "exported"]),
        sql`normalize_vendor_text(${extractedInvoices.vendorName}) = normalize_vendor_text(${vendorName})`,
        sql`${extractedInvoices.id} != ${excludeInvoiceId}`,
        isNotNull(extractedInvoices.reviewedAt),
      ),
    )
    .orderBy(desc(extractedInvoices.reviewedAt))
    .limit(1);
  return row ?? null;
}

async function findLineConfidenceSnapshots(
  tx: Tx,
  lineIds: string[],
): Promise<LineConfidenceSnapshot[]> {
  return tx
    .select({
      id: extractedInvoiceLines.id,
      lineNumber: extractedInvoiceLines.lineNumber,
      confidenceScore: extractedInvoiceLines.confidenceScore,
      confidenceReason: extractedInvoiceLines.confidenceReason,
      histSampleCount: extractedInvoiceLines.histSampleCount,
      histAvgPrice: extractedInvoiceLines.histAvgPrice,
      histStddevPrice: extractedInvoiceLines.histStddevPrice,
      stddevDistance: extractedInvoiceLines.stddevDistance,
      updatedAt: extractedInvoiceLines.updatedAt,
    })
    .from(extractedInvoiceLines)
    .where(inArray(extractedInvoiceLines.id, lineIds));
}

async function updateLineConfidenceBatch(
  tx: Tx,
  updates: LineConfidenceUpdate[],
): Promise<void> {
  if (updates.length === 0) return;
  const lineIds = updates.map((u) => u.lineId);

  // PR18 C4 — batch the per-line confidence writes into one CASE
  // UPDATE instead of one round trip per line. Per-value bindings go
  // through the sql tag — only the static column name, CASE keyword,
  // and cast type reach sql.raw, all hard-coded literals.
  //
  // Explicit cast on the whole CASE expression: when every THEN branch
  // in a batch binds a JS `null` (e.g. histSampleCount for a
  // never-before-seen item keyword — no vendor pricing history to
  // report), the expression has no typed column reference to infer
  // from and Postgres defaults it to `text`, which the numeric/integer
  // target columns then reject ("column is of type integer but
  // expression is of type text"). Casting removes the ambiguity
  // regardless of how many rows are null in this batch.
  const caseExpr = (
    column: string,
    pick: (u: LineConfidenceUpdate) => unknown,
    castType?: "int" | "numeric",
  ) => {
    const chunks = updates.map((u) => sql`WHEN ${u.lineId}::uuid THEN ${pick(u)}`);
    const expr = sql.join([sql.raw(`CASE ${column}`), ...chunks, sql.raw("END")], sql.raw(" "));
    return castType ? sql`(${expr})::${sql.raw(castType)}` : expr;
  };

  await tx
    .update(extractedInvoiceLines)
    .set({
      confidenceScore: caseExpr("id", (u) => u.score),
      confidenceReason: caseExpr("id", (u) => u.reason),
      histSampleCount: caseExpr("id", (u) => u.histSampleCount, "int"),
      histAvgPrice: caseExpr("id", (u) => u.histAvgPrice, "numeric"),
      histStddevPrice: caseExpr("id", (u) => u.histStddevPrice, "numeric"),
      stddevDistance: caseExpr("id", (u) => u.stddevDistance, "numeric"),
      updatedAt: sql`now()`,
    })
    .where(inArray(extractedInvoiceLines.id, lineIds));
}

async function findStatusForValidation(
  tx: Tx,
  organizationId: string,
  extractedInvoiceId: string,
): Promise<InvoiceStatusForValidation | null> {
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
  return row ?? null;
}

async function updateReviewStatusIfActive(
  tx: Tx,
  invoiceId: string,
  newStatus: "pending" | "needs_review",
  activeStatuses: string[],
): Promise<void> {
  await tx
    .update(extractedInvoices)
    .set({
      reviewStatus: newStatus,
      // PR7 — review #4: use DB clock so updatedAt aligns with the tx
      // commit timestamp regardless of worker clock drift.
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(extractedInvoices.id, invoiceId),
        inArray(
          extractedInvoices.reviewStatus,
          activeStatuses as Array<(typeof extractedInvoices.$inferSelect)["reviewStatus"]>,
        ),
      ),
    );
}

export const drizzleInvoiceRepository: InvoiceRepository = {
  lockForValidation,
  findForValidation,
  findPriorApprovedKeys,
  findLatestApprovedRemitTo,
  findLineConfidenceSnapshots,
  updateLineConfidenceBatch,
  findStatusForValidation,
  updateReviewStatusIfActive,
};
