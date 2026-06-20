/**
 * Phase 11 — D4 Audit-Ready Evidence Packet.
 *
 * Pure assembly of the manifest that gets sealed onto evidence_packets.
 * Takes a tx (org context already pinned) + extractedInvoiceId, returns
 * { manifest, manifestHash, sourceDocumentHash, documentId, sealedByUserId }
 * ready for the caller to INSERT.
 *
 * Manifest shape mirrors the MVP spec §D4 evidence packet contents:
 *   - originalDocument: hash + storage key
 *   - extractedInvoice: full JSON with confidence scores
 *   - extractedLines: full lines including per-line confidence (the
 *     pre-edit history lives in audit_events.metadata_json from the
 *     PR12 C4 fix; we snapshot the current values here)
 *   - validation: active validation_results row (errorsJson with
 *     context — sanctioned in this evidence context)
 *   - briefingCard: active row at approve time (the one pinned in
 *     invoice.approved.metadataJson per PR6)
 *   - vendorProfileSnapshot: from briefingCards.vendor_context_json
 *   - approverActionLog: invoice.approved audit event metadata (already
 *     carries the full attestation chain after PR12 H1/H2)
 *   - override: invoice_override_log row when present (F02)
 *
 * The manifestHash is SHA-256 over a deterministic JSON serialisation
 * (sorted keys, no extraneous whitespace). Re-running the assembler on
 * the same source rows produces the same hash. This is the auditor's
 * verification handle: given the row, re-compute the hash and check.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  extractedInvoices,
  extractedInvoiceLines,
  documents,
  validationResults,
  briefingCards,
  auditEvents,
  invoiceOverrideLog,
  llmRuns,
} from "@/db/schema";

export interface AssembleResult {
  documentId: string;
  sealedByUserId: string | null;
  sourceDocumentHash: string;
  manifestHash: string;
  manifest: Record<string, unknown>;
}

export async function assembleEvidenceManifest(
  tx: Tx,
  extractedInvoiceId: string,
): Promise<AssembleResult | null> {
  const [invoice] = await tx
    .select()
    .from(extractedInvoices)
    .where(eq(extractedInvoices.id, extractedInvoiceId))
    .limit(1);
  if (!invoice) return null;

  const [doc] = await tx
    .select()
    .from(documents)
    .where(eq(documents.id, invoice.documentId))
    .limit(1);
  if (!doc) return null;

  const [lines, latestValidation, latestActiveBriefing, approveEvent, overrideRow] =
    await Promise.all([
      tx
        .select()
        .from(extractedInvoiceLines)
        .where(eq(extractedInvoiceLines.extractedInvoiceId, extractedInvoiceId))
        .orderBy(extractedInvoiceLines.lineNumber),
      tx
        .select()
        .from(validationResults)
        .where(
          and(
            eq(validationResults.entityType, "extracted_invoice"),
            eq(validationResults.entityId, extractedInvoiceId),
            isNull(validationResults.supersededAt),
          ),
        )
        .orderBy(desc(validationResults.createdAt))
        .limit(1)
        .then((r) => r[0]),
      tx
        .select()
        .from(briefingCards)
        .where(
          and(
            eq(briefingCards.extractedInvoiceId, extractedInvoiceId),
            isNull(briefingCards.supersededAt),
          ),
        )
        .orderBy(desc(briefingCards.createdAt))
        .limit(1)
        .then((r) => r[0]),
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "invoice.approved"),
            eq(auditEvents.entityType, "extracted_invoice"),
            eq(auditEvents.entityId, extractedInvoiceId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1)
        .then((r) => r[0]),
      tx
        .select()
        .from(invoiceOverrideLog)
        .where(
          eq(invoiceOverrideLog.extractedInvoiceId, extractedInvoiceId),
        )
        .orderBy(desc(invoiceOverrideLog.approvedAt))
        .limit(1)
        .then((r) => r[0]),
    ]);

  // PR14 C-Null-Approver — refuse to seal a packet when the approval
  // attestation can't be resolved. Without this guard the assembler
  // silently produces a packet with sealed_by_user_id=null and
  // approverActionLog=null — sealing successful, audit event fires,
  // BUT the §D4 "who approved" link is broken with no operator signal.
  // Returning null here makes the job throw (re-enqueue with backoff)
  // until either the approve event commits or operator intervention
  // surfaces the issue.
  if (!approveEvent) return null;

  // PR18 — briefing pin desync race. The parallel fan-out above loads
  // the latest-active briefing card via `WHERE supersededAt IS NULL`.
  // But: generateBriefingCard's persist tx never re-checks
  // reviewStatus after the LLM dispatch returns, so a regenerate that
  // started before approve can supersede the original card and insert
  // a new one AFTER approve commits. The approve route pins
  // activeBriefingCardId in invoice.approved.metadataJson — bind the
  // manifest to THAT id, not whichever card happens to be active at
  // job-run time. This makes the evidence packet match the card the
  // approver actually saw, which is the §D4 invariant.
  const pinnedBriefingCardId =
    typeof approveEvent.metadataJson === "object" &&
    approveEvent.metadataJson !== null &&
    "activeBriefingCardId" in approveEvent.metadataJson
      ? (approveEvent.metadataJson.activeBriefingCardId as string | null)
      : null;
  let briefingCard = latestActiveBriefing;
  if (pinnedBriefingCardId && briefingCard?.id !== pinnedBriefingCardId) {
    const [pinnedCard] = await tx
      .select()
      .from(briefingCards)
      .where(eq(briefingCards.id, pinnedBriefingCardId))
      .limit(1);
    if (pinnedCard) briefingCard = pinnedCard;
  }

  // Resolve the LLM run that produced the briefing card (PR12 H1 chain).
  let llmRun: typeof llmRuns.$inferSelect | undefined;
  if (briefingCard?.llmRunId) {
    const [r] = await tx
      .select()
      .from(llmRuns)
      .where(eq(llmRuns.id, briefingCard.llmRunId))
      .limit(1);
    llmRun = r;
  }

  const manifest = {
    schemaVersion: "evidence.v1",
    originalDocument: {
      documentId: doc.id,
      sourceChannel: doc.source ?? null,
      mimeType: doc.mimeType ?? null,
      contentHash: doc.contentHash ?? null,
      storageKey: doc.storageKey ?? null,
      receivedAt: doc.createdAt?.toISOString() ?? null,
      pageCount: doc.pageCount ?? null,
    },
    extractedInvoice: serialiseInvoice(invoice),
    extractedLines: lines.map(serialiseLine),
    validation: latestValidation
      ? {
          validationResultId: latestValidation.id,
          passed: latestValidation.passed,
          severity: latestValidation.severity,
          createdAt: latestValidation.createdAt?.toISOString() ?? null,
          findings: latestValidation.errorsJson,
        }
      : null,
    briefingCard: briefingCard
      ? {
          briefingCardId: briefingCard.id,
          generatedAt: briefingCard.createdAt?.toISOString() ?? null,
          glCode: briefingCard.glCode,
          glRationale: briefingCard.glRationale,
          anomalyFlags: briefingCard.anomalyFlagsJson,
          deltaSummary: briefingCard.deltaSummary,
          riskScore: briefingCard.riskScore,
          riskScoreVersion: briefingCard.riskScoreVersion,
          riskJustification: briefingCard.riskJustification,
          riskFactors: briefingCard.riskFactorsJson,
          coachingPrompts: briefingCard.coachingPromptsJson,
        }
      : null,
    vendorProfileSnapshot: briefingCard?.vendorContextJson ?? null,
    llmRun: llmRun
      ? {
          llmRunId: llmRun.id,
          provider: llmRun.provider,
          model: llmRun.model,
          promptName: llmRun.promptName,
          promptVersion: llmRun.promptVersion,
          inputHash: llmRun.inputHash,
          inputTokensEstimate: llmRun.inputTokensEstimate,
          status: llmRun.status,
          durationMs: llmRun.durationMs,
        }
      : null,
    approverActionLog: approveEvent
      ? {
          auditEventId: approveEvent.id,
          actorId: approveEvent.actorId,
          createdAt: approveEvent.createdAt?.toISOString() ?? null,
          beforeJson: approveEvent.beforeJson,
          metadata: approveEvent.metadataJson,
        }
      : null,
    override: overrideRow
      ? {
          overrideId: overrideRow.id,
          overridingUserId: overrideRow.overridingUserId,
          secondApproverId: overrideRow.secondApproverId,
          justificationText: overrideRow.justificationText,
          overrideAmount: overrideRow.overrideAmount,
          blockingFindingCodes: overrideRow.blockingFindingCodes,
          approvedAt: overrideRow.approvedAt?.toISOString() ?? null,
        }
      : null,
  };

  const manifestHash = canonicalSha256(manifest);

  return {
    documentId: doc.id,
    sealedByUserId:
      typeof approveEvent?.actorId === "string" ? approveEvent.actorId : null,
    sourceDocumentHash: doc.contentHash ?? "",
    manifestHash,
    manifest,
  };
}

function serialiseInvoice(
  inv: typeof extractedInvoices.$inferSelect,
): Record<string, unknown> {
  return {
    extractedInvoiceId: inv.id,
    documentType: inv.documentType,
    vendorName: inv.vendorName,
    vendorAddress: inv.vendorAddress,
    remitToName: inv.remitToName,
    remitToAddress: inv.remitToAddress,
    invoiceNumber: inv.invoiceNumber,
    // PR15 H-Date-Hash — Postgres `date` columns are returned by Drizzle
    // as YYYY-MM-DD strings today, but the binding is not load-bearing
    // — a future Drizzle change to return Date objects would shift the
    // canonical hash for the same logical content, breaking any
    // auditor's recomputation against existing packets. Explicit
    // String coercion pins the contract at the serialiser.
    invoiceDate: inv.invoiceDate === null ? null : String(inv.invoiceDate),
    dueDate: inv.dueDate === null ? null : String(inv.dueDate),
    paymentTerms: inv.paymentTerms,
    purchaseOrderNumber: inv.purchaseOrderNumber,
    currency: inv.currency,
    subtotal: inv.subtotal,
    tax: inv.tax,
    shipping: inv.shipping,
    discount: inv.discount,
    total: inv.total,
    confidence: inv.confidence,
    warnings: inv.warningsJson,
    reviewStatus: inv.reviewStatus,
    reviewedBy: inv.reviewedBy,
    reviewedAt: inv.reviewedAt?.toISOString() ?? null,
  };
}

function serialiseLine(
  l: typeof extractedInvoiceLines.$inferSelect,
): Record<string, unknown> {
  return {
    lineId: l.id,
    lineNumber: l.lineNumber,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: l.amount,
    confidenceScore: l.confidenceScore,
    confidenceReason: l.confidenceReason,
    histSampleCount: l.histSampleCount,
    histAvgPrice: l.histAvgPrice,
    histStddevPrice: l.histStddevPrice,
    stddevDistance: l.stddevDistance,
    updatedAt: l.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Deterministic SHA-256 over the manifest. Keys are sorted recursively
 * so the same logical content always hashes to the same digest,
 * regardless of how the JS object was constructed.
 */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
