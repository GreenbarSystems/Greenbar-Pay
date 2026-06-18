/**
 * PATCH /api/ap/review/:extractedInvoiceId — reviewer edits.
 *
 * Concurrency (addendum §4.7):
 *   - Client sends `If-Match: <updated_at ISO>`.
 *   - WHERE updated_at = $3 — 0 rows → 409 Conflict.
 *   - Reviewer race UI prompts a reload on 409.
 *
 * Idempotency (addendum §4.6, PR2 review #22):
 *   - Optional `Idempotency-Key` header — network retries of the same
 *     PATCH return the cached response instead of producing phantom
 *     `invoice.edited` audit rows and double-validating.
 *   - Same key + different body → 409 idempotency_key_conflict.
 *   - The If-Match check is OUTSIDE the idempotency layer: a retry
 *     after a successful first call will still 409 on stale If-Match
 *     unless the key cache catches it first.
 *
 * After a successful UPDATE we re-run validation in the same tx so the
 * findings reflect the new values immediately.
 *
 * Required permission: invoice.edit.
 */
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { extractedInvoices, auditEvents } from "@/db/schema";
import { can, loadEffectiveRole } from "@/lib/rbac";
import { runValidationInTx } from "@/lib/validation/run";
import { requireUuid } from "@/lib/route-helpers";
import { withIdempotency } from "@/lib/review/idempotencyWrap";

// Only header fields are editable from the review UI. Line items get their
// own endpoint in a follow-up; for now they remain as the LLM extracted.
const PatchSchema = z
  .object({
    vendorName: z.string().nullable().optional(),
    vendorAddress: z.string().nullable().optional(),
    remitToName: z.string().nullable().optional(),
    remitToAddress: z.string().nullable().optional(),
    invoiceNumber: z.string().nullable().optional(),
    invoiceDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    paymentTerms: z.string().nullable().optional(),
    purchaseOrderNumber: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    subtotal: z.string().nullable().optional(),
    tax: z.string().nullable().optional(),
    shipping: z.string().nullable().optional(),
    discount: z.string().nullable().optional(),
    total: z.string().nullable().optional(),
  })
  .strict();

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role, id: userId } = session.user;

  // PR3 — review #16: org-role fast path + per-client elevation inside tx.
  const hasOrgPermission = can(role, "invoice.edit");

  const ifMatch = req.headers.get("If-Match");
  if (!ifMatch) {
    return NextResponse.json(
      { error: "missing_if_match", message: "If-Match header is required for edits" },
      { status: 428 }, // Precondition Required
    );
  }
  const ifMatchDate = new Date(ifMatch);
  if (Number.isNaN(ifMatchDate.getTime())) {
    return NextResponse.json(
      { error: "invalid_if_match", message: "If-Match must be an ISO timestamp" },
      { status: 400 },
    );
  }

  let parsed;
  try {
    parsed = PatchSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  // Idempotency-Key hash covers: method, path, body, AND the If-Match
  // value (so the same key replayed against an updated row hashes
  // differently and isn't silently served the prior response).
  const idempotencyBody = { patch: parsed, ifMatch };

  return withIdempotency(
    req,
    organizationId,
    `/api/ap/review/${params.id}`,
    idempotencyBody,
    async () => {
      return withOrg(organizationId, async (tx) => {
        // Snapshot the row first — gives us the `before` for the audit event
        // and lets us bail early if it's already in a terminal state.
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
        if (!before) return { status: 404, body: { error: "not_found" } };
        if (["approved", "rejected", "exported", "superseded"].includes(before.reviewStatus)) {
          return {
            status: 409,
            body: { error: "terminal_status", status: before.reviewStatus },
          };
        }

        // PR3 — per-client RBAC fallback when org role denied.
        if (!hasOrgPermission) {
          const effective = await loadEffectiveRole(tx, {
            userId,
            clientId: before.clientId,
            orgRole: role,
          });
          if (!can(effective, "invoice.edit")) {
            return {
              status: 403,
              body: {
                error: "forbidden",
                message: `${effective} lacks invoice.edit`,
              },
            };
          }
        }

        // Compare-and-set on updated_at (§4.7).
        const updated = await tx
          .update(extractedInvoices)
          .set({
            ...parsed,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(extractedInvoices.id, params.id),
              eq(extractedInvoices.organizationId, organizationId),
              eq(extractedInvoices.updatedAt, ifMatchDate),
            ),
          )
          .returning({
            id: extractedInvoices.id,
            updatedAt: extractedInvoices.updatedAt,
          });

        if (updated.length === 0) {
          return {
            status: 409,
            body: {
              error: "stale_if_match",
              message: "Invoice was edited by someone else. Reload to see latest.",
            },
          };
        }

        // Re-run validation against the new field values.
        const validation = await runValidationInTx(tx, {
          organizationId,
          extractedInvoiceId: params.id,
          documentId: before.documentId,
        });
        await tx
          .update(extractedInvoices)
          .set({ reviewStatus: validation.newReviewStatus })
          .where(eq(extractedInvoices.id, params.id));

        await tx.insert(auditEvents).values({
          organizationId,
          actorType: "user",
          actorId: userId,
          action: "invoice.edited",
          entityType: "extracted_invoice",
          entityId: params.id,
          beforeJson: pickHeaderFields(before),
          afterJson: parsed,
          metadataJson: { newReviewStatus: validation.newReviewStatus },
        });

        return {
          status: 200,
          body: {
            extractedInvoiceId: params.id,
            updatedAt: updated[0].updatedAt,
            reviewStatus: validation.newReviewStatus,
          },
        };
      });
    },
  );
}

/** Snapshot only the user-visible header fields for the audit `before`. */
function pickHeaderFields(row: Record<string, unknown>) {
  const keys = Object.keys(PatchSchema.shape);
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = row[k];
  return out;
}
