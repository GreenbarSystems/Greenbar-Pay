/**
 * POST /api/ap/review/:id/reject — mark a document as not a real invoice
 * (or otherwise unfit for entry). Reason is required; both the invoice
 * row and parent document advance to rejected.
 *
 * Compare-and-set on review_status (§4.5); reviewed_at from sql`now()`
 * (DB clock, not Node's). Idempotency-Key honored (§4.6). Audit row
 * carries a content snapshot so we know what was rejected.
 */
import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { extractedInvoices, auditEvents, documents } from "@/db/schema";
import { can, loadEffectiveRole } from "@/lib/rbac";
import { withIdempotency } from "@/lib/review/idempotencyWrap";
import {
  requireUuid,
  pickFields,
  INVOICE_HEADER_FIELDS,
} from "@/lib/route-helpers";
// Phase 11.2 — schemas extracted to ./body-schema so the modal-contract
// test imports them without pulling auth/drizzle at test-import time.
import { RejectReasonCode, RejectSchema } from "./body-schema";

export { RejectReasonCode };

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role, id: userId } = session.user;

  // PR3 — review #16: org-role fast path + per-client elevation inside tx.
  const hasOrgPermission = can(role, "invoice.reject");

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
        // Snapshot for audit before mutating.
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

        // PR3 — per-client RBAC fallback when org role denied.
        if (!hasOrgPermission) {
          const effective = await loadEffectiveRole(tx, {
            userId,
            clientId: before.clientId,
            orgRole: role,
          });
          if (!can(effective, "invoice.reject")) {
            return {
              status: 403,
              body: {
                error: "forbidden",
                message: `${effective} lacks invoice.reject`,
              },
            };
          }
        }

        // PR2 — separation of duties (review #2). Symmetric with approve.
        // Reject is less obviously fraud-relevant than approve, but giving
        // the uploader unilateral reject power lets a single actor
        // suppress invoices they don't want to see — same SoD concern.
        const [parentDoc] = await tx
          .select({ id: documents.id, createdBy: documents.createdBy })
          .from(documents)
          .where(eq(documents.id, before.documentId))
          .limit(1);
        if (parentDoc?.createdBy && parentDoc.createdBy === userId) {
          // PR6 — review #2 / #3 SoD denial audit. Same shape as approve;
          // makes the control observable to an auditor.
          await tx.insert(auditEvents).values({
            organizationId,
            actorType: "user",
            actorId: userId,
            action: "invoice.sod_denied",
            entityType: "extracted_invoice",
            entityId: params.id,
            metadataJson: {
              attemptedAction: "reject",
              uploaderId: parentDoc.createdBy,
            },
          });
          return {
            status: 403,
            body: {
              error: "sod_violation",
              message:
                "The user who uploaded this document cannot reject it. Ask a second reviewer.",
            },
          };
        }

        const [updated] = await tx
          .update(extractedInvoices)
          .set({
            reviewStatus: "rejected",
            reviewedBy: userId,
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
          beforeJson: pickFields(
            before as unknown as Record<string, unknown>,
            INVOICE_HEADER_FIELDS,
          ),
          metadataJson: {
            // PR19 — controlled vocabulary. The reviewer's free-text
            // note is intentionally NOT stored on the audit row; only
            // the code lives here. The note (if any) goes into the
            // invoice row's warningsJson for in-app reviewer context.
            reasonCode: body.reasonCode,
            // PR18 — mirrors approve.route.ts. sodChecked is true only
            // when the document actually has a human uploader to check
            // against. Email-ingested docs (createdBy=null) record
            // sodResult="skipped_no_uploader" — the maker-checker
            // control is not applicable rather than silently passing.
            sodChecked: parentDoc?.createdBy !== null && parentDoc?.createdBy !== undefined,
            sodResult:
              parentDoc?.createdBy === null || parentDoc?.createdBy === undefined
                ? "skipped_no_uploader"
                : "passed",
            uploaderId: parentDoc?.createdBy ?? null,
          },
        });

        return {
          status: 200,
          body: { extractedInvoiceId: params.id, reviewStatus: "rejected" },
        };
      });
    },
  );
}
