/**
 * POST /api/ap/review/:id/reject — mark a document as not a real invoice
 * (or otherwise unfit for entry). Reason is required; both the invoice
 * row and parent document advance to rejected.
 *
 * Idempotency-Key honored (§4.6). Compare-and-set on review_status.
 */
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { extractedInvoices, auditEvents, documents } from "@/db/schema";
import { requirePermission } from "@/lib/rbac";
import { withIdempotency } from "@/lib/review/idempotencyWrap";

const RejectSchema = z.object({
  reason: z.string().min(1, "reason is required").max(500),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role, id: userId } = session.user;

  try {
    requirePermission(role, "invoice.reject");
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 403 });
  }

  let body;
  try {
    body = RejectSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  return withIdempotency(
    req,
    organizationId,
    `/api/ap/review/${params.id}/reject`,
    body,
    async () => {
      return withOrg(organizationId, async (tx) => {
        const [updated] = await tx
          .update(extractedInvoices)
          .set({ reviewStatus: "rejected", reviewedBy: userId, reviewedAt: new Date() })
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
          .set({ status: "rejected" })
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
          action: "invoice.rejected",
          entityType: "extracted_invoice",
          entityId: params.id,
          metadataJson: { reason: body.reason },
        });

        return {
          status: 200,
          body: { extractedInvoiceId: params.id, reviewStatus: "rejected" },
        };
      });
    },
  );
}
