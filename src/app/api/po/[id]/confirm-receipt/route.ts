/**
 * PATCH /api/po/:purchaseOrderId/confirm-receipt
 *
 * Marks a PO as received: sets receipt_confirmed_at, receipt_confirmed_by,
 * and status → "received". Idempotent — replaying with the same
 * Idempotency-Key returns the cached response rather than double-confirming.
 *
 * Concurrency: If-Match on purchase_orders.updated_at (§4.7).
 * Required permission: po.confirm_receipt (owner, admin, reviewer).
 */
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { purchaseOrders, auditEvents } from "@/db/schema";
import { can, loadEffectiveRole } from "@/lib/rbac";
import { requireUuid } from "@/lib/route-helpers";
import { withIdempotency } from "@/lib/review/idempotencyWrap";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role, id: userId } = session.user;

  const hasOrgPermission = can(role, "po.confirm_receipt");

  const ifMatch = req.headers.get("If-Match");
  if (!ifMatch) {
    return NextResponse.json(
      { error: "missing_if_match", message: "If-Match header is required" },
      { status: 428 },
    );
  }
  const ifMatchDate = new Date(ifMatch);
  if (Number.isNaN(ifMatchDate.getTime())) {
    return NextResponse.json(
      { error: "invalid_if_match", message: "If-Match must be an ISO timestamp" },
      { status: 400 },
    );
  }

  return withIdempotency(
    req,
    organizationId,
    `/api/po/${params.id}/confirm-receipt`,
    { ifMatch },
    async () => {
      return withOrg(organizationId, async (tx) => {
        const [before] = await tx
          .select()
          .from(purchaseOrders)
          .where(
            and(
              eq(purchaseOrders.id, params.id),
              eq(purchaseOrders.organizationId, organizationId),
            ),
          )
          .limit(1);

        if (!before) return { status: 404, body: { error: "not_found" } };

        if (before.status === "closed" || before.status === "cancelled") {
          return {
            status: 409,
            body: { error: "terminal_status", status: before.status },
          };
        }

        if (!hasOrgPermission) {
          const effective = await loadEffectiveRole(tx, {
            userId,
            clientId: before.clientId,
            orgRole: role,
          });
          if (!can(effective, "po.confirm_receipt")) {
            return {
              status: 403,
              body: { error: "forbidden", message: `${effective} lacks po.confirm_receipt` },
            };
          }
        }

        const updated = await tx
          .update(purchaseOrders)
          .set({
            receiptConfirmedAt: sql`now()`,
            receiptConfirmedBy: userId,
            status: "received",
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(purchaseOrders.id, params.id),
              eq(purchaseOrders.organizationId, organizationId),
              eq(purchaseOrders.updatedAt, ifMatchDate),
            ),
          )
          .returning({
            id: purchaseOrders.id,
            status: purchaseOrders.status,
            receiptConfirmedAt: purchaseOrders.receiptConfirmedAt,
            updatedAt: purchaseOrders.updatedAt,
          });

        if (updated.length === 0) {
          return {
            status: 409,
            body: {
              error: "stale_if_match",
              message: "PO was modified. Reload to see latest.",
            },
          };
        }

        await tx.insert(auditEvents).values({
          organizationId,
          actorType: "user",
          actorId: userId,
          action: "po.receipt_confirmed",
          entityType: "purchase_order",
          entityId: params.id,
          beforeJson: { status: before.status, receiptConfirmedAt: before.receiptConfirmedAt },
          afterJson: { status: "received", receiptConfirmedAt: updated[0]!.receiptConfirmedAt },
          metadataJson: {},
        });

        return {
          status: 200,
          body: {
            purchaseOrderId: params.id,
            status: updated[0]!.status,
            receiptConfirmedAt: updated[0]!.receiptConfirmedAt,
            updatedAt: updated[0]!.updatedAt,
          },
        };
      });
    },
  );
}
