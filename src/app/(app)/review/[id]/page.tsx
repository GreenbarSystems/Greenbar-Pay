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

    return {
      invoice,
      doc,
      lines,
      latestValidation,
      latestVendorMatch,
      vendorProfile,
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
      lines={data.lines}
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
      audits={data.audits.map((a) => ({
        id: a.id,
        action: a.action,
        actorType: a.actorType,
        createdAt: a.createdAt.toISOString(),
      }))}
    />
  );
}
