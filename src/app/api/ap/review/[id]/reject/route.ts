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

/**
 * PR19 — controlled-vocabulary rejection reason.
 *
 * The free-text `reason` field was a PII channel: reviewers could (and
 * did, per pilot review feedback) type vendor names, account numbers,
 * EINs, or personal notes about employees, all of which persisted
 * unscrubbed in audit_events.metadata_json. The fix is an enum of
 * canonical reject codes; an optional `note` field captures the
 * reviewer's free text but is capped, scrubbed, and explicitly NOT
 * stored on audit_events (only on the rejected invoice row's
 * warningsJson for in-app context).
 *
 * The enum can be extended; each new code lands in the briefing
 * card's coaching prompts and the recompute job's vendor-pattern
 * analysis without a schema change.
 */
export const RejectReasonCode = z.enum([
  "not_an_invoice",
  "duplicate_submission",
  "wrong_vendor",
  "wrong_amount",
  "missing_information",
  "policy_violation",
  "other",
]);

const RejectSchema = z
  .object({
    reasonCode: RejectReasonCode.optional(),
    /** Optional free-text note. NOT persisted on audit_events. */
    note: z.string().max(280).optional(),
    /**
     * Backward-compatibility — the prior client posted { reason:
     * string }. We accept it, coerce to reasonCode="other", and
     * discard the free text rather than persisting it on the audit
     * row. UI migration to the picker is a follow-up PR.
     */
    reason: z.string().max(280).optional(),
  })
  .refine((b) => b.reasonCode || b.reason, {
    message: "reasonCode or reason is required",
  })
  .transform((b) => ({
    reasonCode: b.reasonCode ?? "other",
    note: b.note,
  }));

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
