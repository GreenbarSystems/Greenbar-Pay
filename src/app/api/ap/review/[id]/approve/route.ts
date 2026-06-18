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
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import {
  extractedInvoices,
  validationResults,
  auditEvents,
  documents,
} from "@/db/schema";
import { can, loadEffectiveRole } from "@/lib/rbac";
import { withIdempotency } from "@/lib/review/idempotencyWrap";
import {
  requireUuid,
  pickFields,
  INVOICE_HEADER_FIELDS,
} from "@/lib/route-helpers";
import { bootstrapVendorOnApprove } from "@/lib/vendors/bootstrap";
import { getQueue, JOB } from "@/lib/queue";

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role, id: userId } = session.user;

  // PR3 — review #16: org-role check is now the cheap fast path; if the
  // org-wide role doesn't grant, fall through to the per-client lookup
  // inside the tx (after we know the invoice's clientId). Skips a DB
  // round trip for the common case where the org role already permits.
  const hasOrgPermission = can(role, "invoice.approve");

  return withIdempotency(
    req,
    organizationId,
    `/api/ap/review/${params.id}/approve`,
    {},
    async () => {
      const txResult = await withOrg(organizationId, async (tx) => {
        // Block approval until an ACTIVE validation row EXISTS (closes the
        // race window between extract-invoice-data and validate-extracted-
        // invoice) AND, if it exists, has no blocking findings.
        //
        // PR2: validation_results is append-only — `WHERE superseded_at
        // IS NULL` selects the current row, prior runs are preserved.
        const [latest] = await tx
          .select()
          .from(validationResults)
          .where(
            and(
              eq(validationResults.entityType, "extracted_invoice"),
              eq(validationResults.entityId, params.id),
              isNull(validationResults.supersededAt),
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

        // PR3 — per-client RBAC. If org role didn't grant, look up the
        // user's role for THIS client and compose. Per §1.5 effective
        // permission = max(orgRole, clientRole).
        if (!hasOrgPermission) {
          const effective = await loadEffectiveRole(tx, {
            userId,
            clientId: before.clientId,
            orgRole: role,
          });
          if (!can(effective, "invoice.approve")) {
            return {
              status: 403,
              body: {
                error: "forbidden",
                message: `${effective} lacks invoice.approve`,
              },
            };
          }
        }

        // PR2 — separation of duties (review #2):
        // The user who uploaded the source document cannot also approve
        // the resulting invoice. This is the single highest-risk gap the
        // adversarial review flagged. Maker-checker enforced at the
        // service layer because the RBAC role does not differentiate
        // upload vs approve (both `reviewer` permissions).
        const [parentDoc] = await tx
          .select({ id: documents.id, createdBy: documents.createdBy })
          .from(documents)
          .where(eq(documents.id, before.documentId))
          .limit(1);
        if (parentDoc?.createdBy && parentDoc.createdBy === userId) {
          return {
            status: 403,
            body: {
              error: "sod_violation",
              message:
                "The user who uploaded this document cannot approve it. Ask a second reviewer.",
            },
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

        // Phase 7 — D1: auto-bootstrap the vendor master + promote any
        // fuzzy-matched alias. Done inside the same tx so the audit row
        // can record the resolved vendor_id.
        const bootstrap = await bootstrapVendorOnApprove(tx, {
          organizationId,
          clientId: before.clientId,
          extractedInvoiceId: params.id,
          extractedVendorName: before.vendorName,
          extractedPaymentTerms: before.paymentTerms,
        });

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
            // SoD check outcome — recorded so audit can prove the
            // separation-of-duties guard ran and passed.
            sodChecked: true,
            sodPassed: true,
            vendorBootstrap: bootstrap,
            uploaderId: parentDoc?.createdBy ?? null,
          },
        });

        return {
          status: 200,
          body: {
            extractedInvoiceId: params.id,
            reviewStatus: "approved",
            vendorBootstrap: bootstrap,
          },
          // Phase 7 — D1: vendor profile recompute is enqueued AFTER
          // commit, not inside the tx. Stashing the vendorId here.
          enqueueRecompute: bootstrap?.vendorId ?? null,
        };
      });

      // Phase 7 — D1: kick the profile recompute job once the approve
      // committed. The job is idempotent on vendorId — a duplicate
      // delivery just re-aggregates and writes the same numbers.
      if (
        "enqueueRecompute" in txResult &&
        typeof txResult.enqueueRecompute === "string"
      ) {
        const boss = await getQueue();
        await boss.send(
          JOB.recomputeVendorProfile,
          { vendorId: txResult.enqueueRecompute, organizationId },
          { singletonKey: `recompute-vendor-profile:${txResult.enqueueRecompute}` },
        );
      }

      return { status: txResult.status, body: txResult.body };
    },
  );
}
