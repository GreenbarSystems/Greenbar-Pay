/**
 * POST /api/ap/review/:id/approve — finalize a reviewed invoice.
 *
 * Refuses to approve while blocking validation findings are present —
 * those have to be resolved via PATCH first.
 *
 * Compare-and-set on review_status (§4.5):
 *   WHERE review_status IN ('pending', 'needs_review')
 * Idempotency-Key honored (§4.6).
 */
import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import {
  extractedInvoices,
  validationResults,
  auditEvents,
  documents,
} from "@/db/schema";
import { requirePermission } from "@/lib/rbac";
import { withIdempotency } from "@/lib/review/idempotencyWrap";

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role, id: userId } = session.user;

  try {
    requirePermission(role, "invoice.approve");
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 403 });
  }

  return withIdempotency(
    req,
    organizationId,
    `/api/ap/review/${params.id}/approve`,
    {},
    async () => {
      return withOrg(organizationId, async (tx) => {
        // Block approval while blocking findings exist.
        const [latest] = await tx
          .select()
          .from(validationResults)
          .where(
            and(
              eq(validationResults.entityType, "extracted_invoice"),
              eq(validationResults.entityId, params.id),
            ),
          )
          .orderBy(desc(validationResults.createdAt))
          .limit(1);
        if (latest && latest.severity === "blocking" && !latest.passed) {
          return {
            status: 422,
            body: {
              error: "blocking_findings",
              message:
                "Invoice has blocking validation findings. Resolve via PATCH before approving.",
            },
          };
        }

        const [updated] = await tx
          .update(extractedInvoices)
          .set({ reviewStatus: "approved", reviewedBy: userId, reviewedAt: new Date() })
          .where(
            and(
              eq(extractedInvoices.id, params.id),
              eq(extractedInvoices.organizationId, organizationId),
              inArray(extractedInvoices.reviewStatus, ["pending", "needs_review"]),
            ),
          )
          .returning({
            id: extractedInvoices.id,
            documentId: extractedInvoices.documentId,
          });

        if (!updated) {
          return {
            status: 409,
            body: { error: "not_active", message: "Invoice is not in a reviewable state." },
          };
        }

        await tx
          .update(documents)
          .set({ status: "approved" })
          .where(
            and(
              eq(documents.id, updated.documentId),
              inArray(documents.status, ["review_required", "llm_extracted"]),
            ),
          );

        await tx.insert(auditEvents).values({
          organizationId,
          actorType: "user",
          actorId: userId,
          action: "invoice.approved",
          entityType: "extracted_invoice",
          entityId: params.id,
        });

        return {
          status: 200,
          body: { extractedInvoiceId: params.id, reviewStatus: "approved" },
        };
      });
    },
  );
}
