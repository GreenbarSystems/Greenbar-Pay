import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import {
  documents,
  extractedInvoices,
  extractedInvoiceLines,
  validationResults,
  vendorMatches,
  vendors,
  briefingCards,
  auditEvents,
  invoiceOverrideLog,
  users,
} from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { storage } from "@/lib/storage";
import { can, loadEffectiveRole } from "@/lib/rbac";
import ReviewDetailClient from "./ReviewDetailClient";

export default async function ReviewDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId, role, id: userId } = session.user;

  const data = await withOrg(organizationId, async (tx) => {
    const [invoice] = await tx
      .select()
      .from(extractedInvoices)
      .where(
        and(
          eq(extractedInvoices.id, params.id),
          eq(extractedInvoices.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!invoice) return null;

    const [doc] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, invoice.documentId))
      .limit(1);

    // PR11 H8 — explicit projection. select() was shipping the new
    // Phase 9 hist_avg_price, hist_stddev_price, and stddev_distance
    // columns to the browser via the RSC payload — per-vendor financial
    // baselines that the UI never renders. The confidence chip + tooltip
    // only use confidence_score + confidence_reason; everything else
    // belongs in the sanctioned validation_results lineage, not the
    // wire.
    const lines = await tx
      .select({
        id: extractedInvoiceLines.id,
        lineNumber: extractedInvoiceLines.lineNumber,
        description: extractedInvoiceLines.description,
        quantity: extractedInvoiceLines.quantity,
        unitPrice: extractedInvoiceLines.unitPrice,
        amount: extractedInvoiceLines.amount,
        confidenceScore: extractedInvoiceLines.confidenceScore,
        confidenceReason: extractedInvoiceLines.confidenceReason,
      })
      .from(extractedInvoiceLines)
      .where(eq(extractedInvoiceLines.extractedInvoiceId, invoice.id))
      .orderBy(extractedInvoiceLines.lineNumber);

    // PR2: filter on superseded_at IS NULL — prior runs are preserved
    // but only the active row drives UI state.
    const [latestValidation] = await tx
      .select()
      .from(validationResults)
      .where(
        and(
          eq(validationResults.entityType, "extracted_invoice"),
          eq(validationResults.entityId, invoice.id),
          isNull(validationResults.supersededAt),
        ),
      )
      .orderBy(desc(validationResults.createdAt))
      .limit(1);

    const [latestVendorMatch] = await tx
      .select()
      .from(vendorMatches)
      .where(eq(vendorMatches.extractedInvoiceId, invoice.id))
      .orderBy(desc(vendorMatches.createdAt))
      .limit(1);

    // Phase 7 — D1: pull the vendor profile snapshot for the side card.
    let vendorProfile: typeof vendors.$inferSelect | null = null;
    if (latestVendorMatch?.vendorId) {
      const [v] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, latestVendorMatch.vendorId))
        .limit(1);
      vendorProfile = v ?? null;
    }

    const audits = await tx
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, "extracted_invoice"),
          eq(auditEvents.entityId, invoice.id),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(20);

    // Phase 11.2 — F02 override log row when present. Joined with
    // users to surface the second-approver name in the badge without
    // a second client-side fetch. invoice_override_log is append-only
    // (DB-level RULE) so at most one row exists per invoice; LIMIT 1
    // is a defensive bound, not a correctness requirement.
    const [overrideRow] = await tx
      .select({
        id: invoiceOverrideLog.id,
        approvedAt: invoiceOverrideLog.approvedAt,
        blockingFindingCodes: invoiceOverrideLog.blockingFindingCodes,
        secondApproverName: users.name,
        secondApproverEmail: users.email,
      })
      .from(invoiceOverrideLog)
      .leftJoin(users, eq(users.id, invoiceOverrideLog.secondApproverId))
      .where(eq(invoiceOverrideLog.extractedInvoiceId, invoice.id))
      .limit(1);

    // Phase 8 — D2: pull the active briefing card (filtered to
    // superseded_at IS NULL — same append-only pattern as validation).
    //
    // PR7 — review #5: explicit projection. The review detail UI only
    // renders these fields; selecting * also dragged vendor_context_json
    // and risk_factors_json (full snapshot blobs) over the wire and into
    // server memory for nothing. Evidence packet (Phase 11) re-fetches
    // the full row from the DB; UI doesn't need it here.
    const [briefingCard] = await tx
      .select({
        // Phase 10 — D5 adds coachingPromptsJson; otherwise unchanged.
        id: briefingCards.id,
        glCode: briefingCards.glCode,
        glRationale: briefingCards.glRationale,
        anomalyFlagsJson: briefingCards.anomalyFlagsJson,
        deltaSummary: briefingCards.deltaSummary,
        riskScore: briefingCards.riskScore,
        riskJustification: briefingCards.riskJustification,
        coachingPromptsJson: briefingCards.coachingPromptsJson,
        createdAt: briefingCards.createdAt,
      })
      .from(briefingCards)
      .where(
        and(
          eq(briefingCards.extractedInvoiceId, invoice.id),
          isNull(briefingCards.supersededAt),
        ),
      )
      .orderBy(desc(briefingCards.createdAt))
      .limit(1);

    // Phase 11.2 — resolve effective role against the invoice's
    // clientId so the UI gate matches the route's gate exactly.
    // Mirrors the approve route's role composition: invoice.override
    // requires admin/owner at either the org or the client level.
    const composedRole = await loadEffectiveRole(tx, {
      userId,
      clientId: invoice.clientId,
      orgRole: role,
    });

    return {
      invoice,
      doc,
      lines,
      latestValidation,
      latestVendorMatch,
      vendorProfile,
      briefingCard,
      audits,
      overrideRow,
      composedRole,
    };
  });

  if (!data || !data.doc) notFound();

  // PR19 — signed URL TTL aligned with the export download route
  // (120s). The prior 300s window was unnecessarily wide: an iframe
  // loads the document well within 10s. Shorter window narrows the
  // exposure if the URL ends up in browser history / extension caches.
  const fileUrl = await storage.getSignedUrl(data.doc.storageKey, 120);

  // Phase 11.2 — canOverride is computed server-side using the same
  // role resolution as the approve route (loadEffectiveRole). The
  // client receives a boolean only; never the role itself, so a
  // tampered DevTools value can't elevate.
  const canOverride = can(data.composedRole, "invoice.override");

  return (
    <ReviewDetailClient
      role={role}
      canOverride={canOverride}
      fileUrl={fileUrl}
      fileMime={data.doc.mimeType ?? "application/octet-stream"}
      override={
        data.overrideRow
          ? {
              approvedAt: data.overrideRow.approvedAt.toISOString(),
              blockingFindingCodes: Array.isArray(
                data.overrideRow.blockingFindingCodes,
              )
                ? (data.overrideRow.blockingFindingCodes as string[])
                : [],
              // PR16-style boundary discipline: name OR email, never
              // the user id (id is the server's join key and has no
              // UI use). Falls back to email when name is null.
              secondApprover:
                data.overrideRow.secondApproverName ??
                data.overrideRow.secondApproverEmail ??
                null,
            }
          : null
      }
      invoice={{
        ...data.invoice,
        // Drizzle returns numerics as strings; the client form keeps them as strings.
        updatedAt: data.invoice.updatedAt.toISOString(),
      }}
      lines={data.lines.map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        // Phase 9 — F06. Cast TEXT → union; DB CHECK constraint
        // restricts to the same set, so the narrow cast is sound.
        confidenceScore: l.confidenceScore as
          | "high"
          | "medium"
          | "low"
          | "new"
          | null,
        confidenceReason: l.confidenceReason,
      }))}
      findings={
        // PR11 — strip `context` at the browser boundary. errors_json
        // is the sanctioned storage shape (validation_results table)
        // and carries per-vendor historyAvg / unitPrice / variancePct
        // on Phase 9 drift findings. The review UI only renders
        // {code, severity, message} — the structured numbers stay in
        // the DB row.
        Array.isArray(data.latestValidation?.errorsJson)
          ? (
              data.latestValidation!.errorsJson as Array<{
                code: string;
                severity: string;
                message: string;
                context?: unknown;
              }>
            ).map((f) => ({
              code: f.code,
              severity: f.severity,
              message: f.message,
            }))
          : []
      }
      vendorMatch={
        data.latestVendorMatch
          ? {
              confidence: data.latestVendorMatch.matchConfidence,
              score: data.latestVendorMatch.matchScore,
              method: data.latestVendorMatch.matchMethod,
              candidates: Array.isArray(data.latestVendorMatch.candidatesJson)
                ? (data.latestVendorMatch.candidatesJson as Array<{
                    id: string;
                    name: string;
                    score: number;
                  }>)
                : [],
            }
          : null
      }
      vendorProfile={
        data.vendorProfile
          ? {
              id: data.vendorProfile.id,
              name: data.vendorProfile.name,
              invoiceCount: data.vendorProfile.invoiceCount,
              spend30d: data.vendorProfile.spend30d,
              spend90d: data.vendorProfile.spend90d,
              avgInvoiceAmount: data.vendorProfile.avgInvoiceAmount,
              defaultPaymentTerms: data.vendorProfile.defaultPaymentTerms,
              termsDriftDetected: data.vendorProfile.termsDriftDetected,
              duplicateSubmissionCount: data.vendorProfile.duplicateSubmissionCount,
              lastInvoiceDate: data.vendorProfile.lastInvoiceDate,
            }
          : null
      }
      briefingCard={
        data.briefingCard
          ? {
              glCode: data.briefingCard.glCode,
              glRationale: data.briefingCard.glRationale,
              // Explicit projection (same fix pattern as PR16 H1 below
              // for coaching_prompts_json). The prior code only had a
              // TS `as` cast, which narrows the compile-time type but
              // does nothing at runtime — Drizzle returns the raw
              // JSONB blob, so any unexpected field the LLM tool-use
              // decoder or a legacy row happened to carry would still
              // serialize into the RSC payload verbatim. The
              // AnomalyFlag schema (src/lib/llm/briefing-card-schema.ts)
              // is intentionally open-ended in its evidenceChain labels,
              // so a future model response drifting outside {code,
              // severity, message, evidenceChain} should not translate
              // into a wire leak. ReviewDetailClient only ever reads
              // those four fields (plus evidenceChain[].{label,detail}).
              anomalyFlags: Array.isArray(data.briefingCard.anomalyFlagsJson)
                ? (
                    data.briefingCard.anomalyFlagsJson as Array<{
                      code?: unknown;
                      severity?: unknown;
                      message?: unknown;
                      evidenceChain?: unknown;
                    }>
                  ).map((f) => ({
                    code: String(f.code ?? ""),
                    severity: (
                      f.severity === "warning" || f.severity === "critical"
                        ? f.severity
                        : "info"
                    ) as "info" | "warning" | "critical",
                    message: String(f.message ?? ""),
                    evidenceChain: Array.isArray(f.evidenceChain)
                      ? (f.evidenceChain as Array<{ label?: unknown; detail?: unknown }>)
                          .map((step) => ({
                            label: String(step.label ?? ""),
                            detail: String(step.detail ?? ""),
                          }))
                      : undefined,
                  }))
                : [],
              deltaSummary: data.briefingCard.deltaSummary,
              riskScore: data.briefingCard.riskScore,
              riskJustification: data.briefingCard.riskJustification,
              generatedAt: data.briefingCard.createdAt.toISOString(),
              // Phase 10 — D5: deterministic coaching prompts.
              // PR16 H1 — explicit projection. The TS cast narrows the
              // shape but Drizzle returns the full JSONB blob, so a
              // bare pass-through shipped `context` (per-vendor
              // projected30dSpend, priorSpend30, avgInvoiceAmount,
              // invoiceTotal, terms strings) across the RSC payload —
              // same systemic boundary leak PR11 C5 caught for
              // validation findings.context. The CoachingPanel only
              // renders message + dollarImpact; the structured
              // numbers live on briefing_cards.coaching_prompts_json
              // for evidence-packet retrieval, never on the wire.
              id: data.briefingCard.id,
              coachingPrompts: Array.isArray(
                data.briefingCard.coachingPromptsJson,
              )
                ? (
                    data.briefingCard.coachingPromptsJson as Array<{
                      code: string;
                      severity: "info" | "warning" | "critical";
                      message: string;
                      dollarImpact?: number | null;
                      context?: unknown;
                    }>
                  ).map((p) => ({
                    code: p.code,
                    severity: p.severity,
                    message: p.message,
                    dollarImpact: p.dollarImpact ?? null,
                  }))
                : [],
            }
          : null
      }
      audits={data.audits.map((a) => ({
        id: a.id,
        action: a.action,
        actorType: a.actorType,
        createdAt: a.createdAt.toISOString(),
      }))}
    />
  );
}
