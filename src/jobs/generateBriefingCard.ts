/**
 * generate-briefing-card — Phase 8 (D2 from updated MVP spec).
 *
 * Trigger: enqueued by validate-extracted-invoice when validation
 * completes. Also re-enqueued by PATCH when an edit forces a
 * re-validation — the briefing must reflect the post-edit state.
 *
 * Steps:
 *   1. Pre-flight: invoice must still be in pending|needs_review.
 *   2. Advisory lock on extracted_invoice_id (same shape as the
 *      validation lock — no two concurrent generations per invoice).
 *   3. Load: invoice + lines, vendor profile (Phase 7), active
 *      validation findings, latest document_extraction (for text
 *      quality), latest prior approved invoice from this vendor
 *      (for delta summary).
 *   4. Compute deterministic risk score + factors.
 *   5. Dispatch LLM Call 2 via the gateway.
 *   6. Persist:
 *        — append llm_runs row;
 *        — supersede prior active briefing_cards row;
 *        — insert new briefing_cards row with the deterministic
 *          score + LLM justification;
 *        — emit audit event.
 *
 * Non-success outcomes from the gateway (text_too_large, quota,
 * circuit, schema_failed, provider_error) STILL produce a llm_runs
 * row. The invoice's UI shows "briefing pending" if no active card
 * exists yet, or the prior card if one does — we don't supersede
 * on failure, so the last successful briefing remains visible.
 */
import type PgBoss from "pg-boss";
import { and, desc, eq, inArray, isNull, sql, ne } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import {
  extractedInvoices,
  extractedInvoiceLines,
  documentExtractions,
  validationResults,
  vendorMatches,
  vendors,
  briefingCards,
  llmRuns,
  auditEvents,
} from "@/db/schema";
import { LOW_TEXT_LENGTH } from "@/lib/ocr/text-quality";
import { computeRiskScore } from "@/lib/briefing/risk-score";
import { dispatchBriefingCardGeneration } from "@/lib/llm";
import { scrubError } from "@/lib/llm/scrub";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

const ACTIVE_REVIEW_STATUSES = ["pending", "needs_review"] as const;

export async function handleGenerateBriefingCard(
  job: PgBoss.Job<JobPayloads[typeof JOB.generateBriefingCard]>,
): Promise<void> {
  const { extractedInvoiceId, organizationId } = job.data;

  // Phase 1 — load + risk score (inside one tx, advisory-locked).
  const prep = await withOrgAsWorker(organizationId, async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended('briefing:' || ${extractedInvoiceId}::text, 0)
      )
    `);

    const [invoice] = await tx
      .select()
      .from(extractedInvoices)
      .where(
        and(
          eq(extractedInvoices.id, extractedInvoiceId),
          eq(extractedInvoices.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!invoice) return null;
    if (!ACTIVE_REVIEW_STATUSES.includes(invoice.reviewStatus as "pending")) {
      // Reviewer already acted (approved/rejected) or row was superseded
      // by a fresh extract. Skip — Phase 11 evidence packet freezes
      // whichever briefing was active at approval time.
      return null;
    }

    const lines = await tx
      .select()
      .from(extractedInvoiceLines)
      .where(eq(extractedInvoiceLines.extractedInvoiceId, extractedInvoiceId))
      .orderBy(extractedInvoiceLines.lineNumber);

    const [latestValidation] = await tx
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
      .limit(1);

    const findingsRaw =
      latestValidation && Array.isArray(latestValidation.errorsJson)
        ? (latestValidation.errorsJson as Array<{
            code: string;
            severity: string;
            message: string;
          }>)
        : [];
    const blockingFindingCount = findingsRaw.filter(
      (f) => f.severity === "blocking",
    ).length;
    const warningFindingCount = findingsRaw.filter(
      (f) => f.severity === "warning",
    ).length;

    const [latestExtraction] = await tx
      .select({ textLength: documentExtractions.textLength })
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, invoice.documentId))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(1);
    const textQualityLow =
      latestExtraction !== undefined &&
      latestExtraction.textLength !== null &&
      latestExtraction.textLength < LOW_TEXT_LENGTH;

    // Vendor profile via the latest match row.
    const [latestMatch] = await tx
      .select({ vendorId: vendorMatches.vendorId })
      .from(vendorMatches)
      .where(eq(vendorMatches.extractedInvoiceId, extractedInvoiceId))
      .orderBy(desc(vendorMatches.createdAt))
      .limit(1);

    let vendorProfile: typeof vendors.$inferSelect | null = null;
    let priorInvoice: typeof extractedInvoices.$inferSelect | null = null;
    let priorLines: Array<{ description: string | null }> = [];

    if (latestMatch?.vendorId) {
      const [v] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, latestMatch.vendorId))
        .limit(1);
      vendorProfile = v ?? null;
    }
    if (vendorProfile) {
      // Latest approved invoice from this vendor (excluding ourselves)
      // for the delta summary. Matched on canonical name as Phase 7
      // does — Phase 8 follow-up could replace with vendor_id FK.
      const [p] = await tx
        .select()
        .from(extractedInvoices)
        .where(
          and(
            eq(extractedInvoices.organizationId, organizationId),
            inArray(extractedInvoices.reviewStatus, ["approved", "exported"]),
            eq(extractedInvoices.vendorName, vendorProfile.name),
            ne(extractedInvoices.id, extractedInvoiceId),
          ),
        )
        .orderBy(desc(extractedInvoices.invoiceDate))
        .limit(1);
      priorInvoice = p ?? null;

      if (priorInvoice) {
        priorLines = await tx
          .select({ description: extractedInvoiceLines.description })
          .from(extractedInvoiceLines)
          .where(eq(extractedInvoiceLines.extractedInvoiceId, priorInvoice.id))
          .orderBy(extractedInvoiceLines.lineNumber)
          .limit(5);
      }
    }

    const risk = computeRiskScore({
      blockingFindingCount,
      warningFindingCount,
      vendorTermsDrift: vendorProfile?.termsDriftDetected ?? false,
      vendorDuplicateCount: vendorProfile?.duplicateSubmissionCount ?? 0,
      textQualityLow,
      vendorWarmingUp: (vendorProfile?.invoiceCount ?? 0) < 3,
    });

    return {
      invoice,
      lines,
      findings: findingsRaw,
      vendorProfile,
      priorInvoice,
      priorLines,
      risk,
    };
  });

  if (!prep) return;

  // Phase 2 — dispatch the LLM. Network call lives outside the tx so
  // we don't hold a row lock across the round trip.
  const outcome = await dispatchBriefingCardGeneration({
    organizationId,
    invoice: {
      documentType: prep.invoice.documentType,
      vendorName: prep.invoice.vendorName,
      invoiceNumber: prep.invoice.invoiceNumber,
      invoiceDate: prep.invoice.invoiceDate,
      dueDate: prep.invoice.dueDate,
      paymentTerms: prep.invoice.paymentTerms,
      currency: prep.invoice.currency,
      subtotal: numericOrNull(prep.invoice.subtotal),
      tax: numericOrNull(prep.invoice.tax),
      shipping: numericOrNull(prep.invoice.shipping),
      discount: numericOrNull(prep.invoice.discount),
      total: numericOrNull(prep.invoice.total),
      lineItems: prep.lines.map((l) => ({
        description: l.description,
        quantity: numericOrNull(l.quantity),
        unitPrice: numericOrNull(l.unitPrice),
        amount: numericOrNull(l.amount),
      })),
    },
    vendorProfile: prep.vendorProfile
      ? {
          invoiceCount: prep.vendorProfile.invoiceCount,
          lastInvoiceDate: prep.vendorProfile.lastInvoiceDate,
          spend30d: prep.vendorProfile.spend30d,
          spend90d: prep.vendorProfile.spend90d,
          avgInvoiceAmount: prep.vendorProfile.avgInvoiceAmount,
          defaultPaymentTerms: prep.vendorProfile.defaultPaymentTerms,
          defaultGlCode: prep.vendorProfile.defaultGlCode,
          termsDriftDetected: prep.vendorProfile.termsDriftDetected,
          duplicateSubmissionCount: prep.vendorProfile.duplicateSubmissionCount,
          aliases: prep.vendorProfile.aliases,
        }
      : null,
    findings: prep.findings,
    priorInvoice: prep.priorInvoice
      ? {
          invoiceNumber: prep.priorInvoice.invoiceNumber,
          invoiceDate: prep.priorInvoice.invoiceDate,
          paymentTerms: prep.priorInvoice.paymentTerms,
          currency: prep.priorInvoice.currency,
          total: prep.priorInvoice.total,
          topLineDescriptions: prep.priorLines
            .map((l) => l.description)
            .filter((d): d is string => d !== null),
        }
      : null,
    riskScore: prep.risk.score,
    riskFactors: prep.risk.factors,
  });

  // Phase 3 — persist outcome.
  await withOrgAsWorker(organizationId, async (tx) => {
    // Every outcome lands an llm_runs row (succeeded or not).
    const meta = outcome.meta;
    const runStatus = mapOutcomeToRunStatus(outcome);
    const errorMessage =
      outcome.kind === "schema_failed"
        ? "schema validation failed after retry"
        : outcome.kind === "provider_error"
          ? scrubError(outcome.error).message.slice(0, 500)
          : outcome.kind === "non_compliant_model"
            ? outcome.error.message
            : outcome.kind === "text_too_large"
              ? "input too large"
              : outcome.kind === "quota_exceeded"
                ? "daily quota exhausted"
                : outcome.kind === "circuit_open"
                  ? "provider circuit open"
                  : null;

    const [run] = await tx
      .insert(llmRuns)
      .values({
        organizationId,
        documentId: prep.invoice.documentId,
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

    if (outcome.kind !== "succeeded") {
      // Non-success: keep the prior briefing visible (if any). Audit
      // event so an operator can see why the briefing didn't refresh.
      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "worker",
        action: `briefing.${runStatus}`,
        entityType: "extracted_invoice",
        entityId: extractedInvoiceId,
        metadataJson: { llmRunId: run.id, runStatus },
      });
      return;
    }

    // Success: supersede prior active row, insert fresh.
    await tx
      .update(briefingCards)
      .set({ supersededAt: sql`now()` })
      .where(
        and(
          eq(briefingCards.extractedInvoiceId, extractedInvoiceId),
          isNull(briefingCards.supersededAt),
        ),
      );

    const r = outcome.result;
    await tx.insert(briefingCards).values({
      organizationId,
      extractedInvoiceId,
      llmRunId: run.id,
      glCode: r.glCode,
      glRationale: r.glRationale,
      anomalyFlagsJson: r.anomalyFlags,
      deltaSummary: r.deltaSummary,
      riskScore: prep.risk.score,
      riskJustification: r.riskJustification,
      vendorContextJson: prep.vendorProfile,
      riskFactorsJson: prep.risk.factors,
    });

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "briefing.generated",
      entityType: "extracted_invoice",
      entityId: extractedInvoiceId,
      metadataJson: {
        llmRunId: run.id,
        riskScore: prep.risk.score,
        anomalyFlagCount: r.anomalyFlags.length,
        glCode: r.glCode,
      },
    });
  });
}

function numericOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapOutcomeToRunStatus(
  outcome: { kind: string },
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
    default:
      return "provider_error";
  }
}
