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
} from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { storage } from "@/lib/storage";
import ReviewDetailClient from "./ReviewDetailClient";

export default async function ReviewDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId, role } = session.user;

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

    const lines = await tx
      .select()
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
        glCode: briefingCards.glCode,
        glRationale: briefingCards.glRationale,
        anomalyFlagsJson: briefingCards.anomalyFlagsJson,
        deltaSummary: briefingCards.deltaSummary,
        riskScore: briefingCards.riskScore,
        riskJustification: briefingCards.riskJustification,
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

    return {
      invoice,
      doc,
      lines,
      latestValidation,
      latestVendorMatch,
      vendorProfile,
      briefingCard,
      audits,
    };
  });

  if (!data || !data.doc) notFound();

  const fileUrl = await storage.getSignedUrl(data.doc.storageKey, 300);

  return (
    <ReviewDetailClient
      role={role}
      fileUrl={fileUrl}
      fileMime={data.doc.mimeType ?? "application/octet-stream"}
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
        Array.isArray(data.latestValidation?.errorsJson)
          ? (data.latestValidation!.errorsJson as Array<{
              code: string;
              severity: string;
              message: string;
            }>)
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
              anomalyFlags: Array.isArray(data.briefingCard.anomalyFlagsJson)
                ? (data.briefingCard.anomalyFlagsJson as Array<{
                    code: string;
                    severity: "info" | "warning" | "critical";
                    message: string;
                    // Phase 9 — F07: optional reasoning chain.
                    evidenceChain?: Array<{ label: string; detail: string }>;
                  }>)
                : [],
              deltaSummary: data.briefingCard.deltaSummary,
              riskScore: data.briefingCard.riskScore,
              riskJustification: data.briefingCard.riskJustification,
              generatedAt: data.briefingCard.createdAt.toISOString(),
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
