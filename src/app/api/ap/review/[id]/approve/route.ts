/**
 * POST /api/ap/review/:id/approve — finalize a reviewed invoice.
 *
 * Refuses to approve while blocking validation findings are present —
 * those have to be resolved via PATCH first.
 *
 * Refuses to approve while NO validation row exists yet — that closes
 * the race window between extract-invoice-data completing and
 * validate-extracted-invoice running.
 *
 * Refuses to approve when the same user uploaded the source document
 * (separation of duties — placeholder; PR2 wires this with audit
 * metadata).  TODO(SoD): see review #2.
 *
 * Compare-and-set on review_status (§4.5):
 *   WHERE review_status IN ('pending', 'needs_review')
 * `reviewed_at` is sourced from the DB clock (sql`now()`) — Node
 * `new Date()` would be a forgeable attestation timestamp.
 * Idempotency-Key honored (§4.6).
 *
 * Audit row carries a content snapshot in `beforeJson` so the
 * attestation event proves *what* was approved, not just that
 * someone clicked approve.
 */
import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
import {
  requireUuid,
  pickFields,
  INVOICE_HEADER_FIELDS,
} from "@/lib/route-helpers";

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

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
        // Block approval until a validation row EXISTS (closes the race
        // window between extract-invoice-data and validate-extracted-invoice)
        // AND, if it exists, has no blocking findings.
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
        if (!latest) {
          return {
            status: 409,
            body: {
              error: "validation_pending",
              message:
                "Validation has not run yet for this invoice. Retry in a few seconds.",
            },
          };
        }
        if (latest.severity === "blocking" && !latest.passed) {
          return {
            status: 422,
            body: {
              error: "blocking_findings",
              message:
                "Invoice has blocking validation findings. Resolve via PATCH before approving.",
            },
          };
        }

        // Snapshot the row BEFORE the UPDATE so the audit event records
        // the content that was approved. PATCH already does this.
        const [before] = await tx
          .select()
          .from(extractedInvoices)
          .where(
            and(
              eq(extractedInvoices.id, params.id),
              eq(extractedInvoices.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!before) {
          return {
            status: 404,
            body: { error: "not_found" },
          };
        }

        const [updated] = await tx
          .update(extractedInvoices)
          .set({
            reviewStatus: "approved",
            reviewedBy: userId,
            // DB clock — Node `new Date()` is forgeable, every other
            // timestamp in this codebase is server-side.
            reviewedAt: sql`now()`,
          })
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
          beforeJson: pickFields(
            before as unknown as Record<string, unknown>,
            INVOICE_HEADER_FIELDS,
          ),
          metadataJson: {
            validationResultId: latest.id,
            findingCount: Array.isArray(latest.errorsJson)
              ? (latest.errorsJson as unknown[]).length
              : 0,
          },
        });

        return {
          status: 200,
          body: { extractedInvoiceId: params.id, reviewStatus: "approved" },
        };
      });
    },
  );
}
