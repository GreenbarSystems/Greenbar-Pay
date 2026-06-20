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
import {
  computeRiskScore,
  RISK_SCORE_VERSION,
  riskBand,
} from "@/lib/briefing/risk-score";
import { computeCoachingPrompts } from "@/lib/coaching/compute";
import type { ValidationFinding } from "@/lib/validation";
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

    // PR8 — review perf #3: fan out the four independent loads in parallel.
    // They share the tx's snapshot so results are consistent. Same pattern
    // PR4 used in the dashboard. Inside a single tx the queries land on
    // one connection (no wire-level parallelism with node-postgres), but
    // hoisting them out of the await chain saves the per-query event-loop
    // schedule and makes the dependency story explicit.
    const [lines, latestValidation, latestExtraction, latestMatch] =
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
          .select({ textLength: documentExtractions.textLength })
          .from(documentExtractions)
          .where(eq(documentExtractions.documentId, invoice.documentId))
          .orderBy(desc(documentExtractions.createdAt))
          .limit(1)
          .then((r) => r[0]),
        tx
          .select({ vendorId: vendorMatches.vendorId })
          .from(vendorMatches)
          .where(eq(vendorMatches.extractedInvoiceId, extractedInvoiceId))
          .orderBy(desc(vendorMatches.createdAt))
          .limit(1)
          .then((r) => r[0]),
      ]);

    // PR11 C5 — strip the `context` field at the boundary. The TS cast
    // below narrows the shape but Drizzle returns the full JSONB object
    // at runtime, so a bare pass-through would ship vendor-attributable
    // numbers (historyAvg, exact unitPrice, variancePct, duplicateKey)
    // to Anthropic in the briefing prompt. The `context` is sanctioned
    // only for validation_results.errors_json — never for the LLM
    // dispatch path. The explicit `.map` ensures the structured numbers
    // stop here even if future findings add more sensitive context
    // shapes.
    const rawErrors =
      latestValidation && Array.isArray(latestValidation.errorsJson)
        ? (latestValidation.errorsJson as Array<{
            code: string;
            severity: string;
            message: string;
            context?: unknown;
          }>)
        : [];
    const findingsRaw: Array<{
      code: string;
      severity: string;
      message: string;
    }> = rawErrors.map((f) => ({
      code: f.code,
      severity: f.severity,
      message: f.message,
    }));
    const blockingFindingCount = findingsRaw.filter(
      (f) => f.severity === "blocking",
    ).length;
    const warningFindingCount = findingsRaw.filter(
      (f) => f.severity === "warning",
    ).length;

    const textQualityLow =
      latestExtraction !== undefined &&
      latestExtraction.textLength !== null &&
      latestExtraction.textLength < LOW_TEXT_LENGTH;

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
            // PR5 — review C7: the prior-invoice lookup used case-sensitive
            // exact match — "ABC Supplies" vs "abc supplies" would miss.
            // Use the same SQL normalization the recompute join uses so
            // any spelling variant resolves to the canonical vendor.
            sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ${vendorProfile.normalizedName}`,
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

    // Phase 9 — D3 + F06: pull rate-drift count + new-line-item flag
    // straight from the active findings list. These were emitted by the
    // validator into validation_results.errors_json — single source of
    // truth, no separate query needed.
    const rateDriftCount = findingsRaw.filter(
      (f) => f.code === "unit_price_drift",
    ).length;
    const hasNewLineItem = findingsRaw.some(
      (f) => f.code === "new_line_item",
    );

    const risk = computeRiskScore({
      blockingFindingCount,
      warningFindingCount,
      vendorTermsDrift: vendorProfile?.termsDriftDetected ?? false,
      vendorDuplicateCount: vendorProfile?.duplicateSubmissionCount ?? 0,
      textQualityLow,
      vendorWarmingUp: (vendorProfile?.invoiceCount ?? 0) < 3,
      rateDriftCount,
      hasNewLineItem,
    });

    return {
      invoice,
      lines,
      // findings = context-stripped, prompt-safe (PR11 C5)
      findings: findingsRaw,
      // findingsFull = sanctioned shape with context — coaching uses
      // this. NEVER reaches the LLM dispatch path.
      findingsFull: rawErrors,
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
    // PR11 M9 — drop the `note` field. The full RiskFactor lives on
    // briefing_cards.riskFactorsJson for the UI/evidence packet; the
    // model only needs the code + weight to pick the strongest factor.
    riskFactors: prep.risk.factors.map((f) => ({
      code: f.code,
      weight: f.weight,
    })),
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
            ? `non_compliant_model: ${scrubError(outcome.error).message.slice(0, 300)}`
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

    // PR19 — re-check the invoice's reviewStatus inside the persist tx.
    // The prep tx (which had its own status check) commits before the
    // LLM dispatch. While dispatch is in flight (~5s) the reviewer can
    // approve the invoice — by the time persist runs the invoice is
    // already `approved` and the pinned briefingCardId in the approve
    // audit event would be silently superseded by this write.
    //
    // Belt-and-braces with PR18 C3 (assembler resolves by pinned id):
    // even if assemble correctly walks the pin, an approve→regenerate
    // race would still leave the active-row state confusing for
    // operators and downstream readers. Skip the supersede+insert when
    // the invoice is no longer in an active review state.
    const [currentInvoice] = await tx
      .select({ reviewStatus: extractedInvoices.reviewStatus })
      .from(extractedInvoices)
      .where(eq(extractedInvoices.id, extractedInvoiceId))
      .limit(1);
    if (
      !currentInvoice ||
      !ACTIVE_REVIEW_STATUSES.includes(
        currentInvoice.reviewStatus as "pending",
      )
    ) {
      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "worker",
        action: "briefing.skipped_after_dispatch",
        entityType: "extracted_invoice",
        entityId: extractedInvoiceId,
        metadataJson: {
          llmRunId: run.id,
          reviewStatusAtPersist: currentInvoice?.reviewStatus ?? null,
          reason:
            "Invoice transitioned out of an active review status while LLM dispatch was in flight — skipping supersede to keep the approve-time pin intact.",
        },
      });
      return;
    }

    // PR12 H3 — read the prior briefing's score BEFORE we supersede it,
    // so we can detect band crossings and emit a dedicated audit event.
    // The active-active partial unique index guarantees at most one row;
    // priorScore is null on the very first briefing for an invoice.
    const [priorBriefing] = await tx
      .select({ riskScore: briefingCards.riskScore })
      .from(briefingCards)
      .where(
        and(
          eq(briefingCards.extractedInvoiceId, extractedInvoiceId),
          isNull(briefingCards.supersededAt),
        ),
      )
      .limit(1);

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
    // Phase 10 — D5: deterministic coaching prompts. Computed inside
    // the same tx as the briefing insert so the row reflects a
    // consistent view of the prep snapshot. The full findings array
    // (including `context`) is the right input here — coaching is a
    // DB-only feature, never crosses the Anthropic boundary.
    const coachingPrompts = computeCoachingPrompts({
      invoice: {
        total: numericOrNull(prep.invoice.total),
        currency: prep.invoice.currency,
        paymentTerms: prep.invoice.paymentTerms,
        invoiceDate: prep.invoice.invoiceDate,
        dueDate: prep.invoice.dueDate,
        // TODO(extraction-schema): the early_payment_discount coaching
        // trigger in src/lib/coaching/compute.ts is structurally dead
        // until extraction produces a typed discount_pct. Today
        // extracted_invoices.discount carries either a % or a $
        // amount in a single numeric column, depending on the
        // model's free-text interpretation, so we cannot safely
        // route it to discountPct. The trigger's logic, schema, and
        // tests stand; flipping it on is a one-line change after the
        // schema lands. Left wired with discountPct=null so the
        // structural dead-path is explicit rather than buried in
        // test coverage.
        discountPct: null,
        discountAmount: numericOrNull(prep.invoice.discount),
      },
      vendorProfile: prep.vendorProfile
        ? {
            invoiceCount: prep.vendorProfile.invoiceCount,
            spend30d: prep.vendorProfile.spend30d,
            avgInvoiceAmount: prep.vendorProfile.avgInvoiceAmount,
            defaultPaymentTerms: prep.vendorProfile.defaultPaymentTerms,
          }
        : null,
      findings: prep.findingsFull as unknown as ValidationFinding[],
    });

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
      // PR6 — review #4: version tag pinned to the runtime constant.
      riskScoreVersion: RISK_SCORE_VERSION,
      vendorContextJson: prep.vendorProfile,
      riskFactorsJson: prep.risk.factors,
      // Phase 10 — D5
      coachingPromptsJson: coachingPrompts,
    });

    // PR12 M10 — record band + strongest factor on briefing.generated
    // so audit queries can identify which invoices crossed into the red
    // band, and which factor drove the score, without joining through
    // briefing_cards.
    const newBand = riskBand(prep.risk.score);
    const dominantFactor = prep.risk.factors[0]?.code ?? null;

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "briefing.generated",
      entityType: "extracted_invoice",
      entityId: extractedInvoiceId,
      metadataJson: {
        llmRunId: run.id,
        riskScore: prep.risk.score,
        riskScoreVersion: RISK_SCORE_VERSION,
        riskBand: newBand,
        dominantFactor,
        anomalyFlagCount: r.anomalyFlags.length,
        glCode: r.glCode,
        // Phase 10 — D5: lets audit queries count coaching coverage
        // without joining briefing_cards.
        coachingPromptCount: coachingPrompts.length,
      },
    });

    // PR12 H3 — band-change attestation event. Fires when the new score
    // crosses a band relative to the immediately-prior briefing card on
    // this invoice. Skipped on the first briefing (no prior to compare)
    // and on intra-band recomputes. Auditors querying for "which
    // invoices ever entered the red band" can filter this single event
    // instead of joining through the full briefing_cards history.
    if (
      priorBriefing &&
      typeof priorBriefing.riskScore === "number" &&
      riskBand(priorBriefing.riskScore) !== newBand
    ) {
      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "worker",
        action: "briefing.band_changed",
        entityType: "extracted_invoice",
        entityId: extractedInvoiceId,
        metadataJson: {
          fromBand: riskBand(priorBriefing.riskScore),
          fromScore: priorBriefing.riskScore,
          toBand: newBand,
          toScore: prep.risk.score,
          dominantFactor,
          riskScoreVersion: RISK_SCORE_VERSION,
        },
      });
    }
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
