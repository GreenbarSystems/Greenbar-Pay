/**
 * POST /api/ap/exports — create an export.
 *
 * Body: { format: 'csv' | 'json', extractedInvoiceIds: string[], clientId?: string }
 *
 * Pattern (addendum §4.5 "Pattern A" + §4.6 Idempotency-Key):
 *   1. Pre-flight: all selected invoices must be reviewStatus='approved'.
 *   2. Insert exports row with status='created' — this row's id is the
 *      idempotency key for the worker.
 *   3. Insert export_items rows.
 *   4. Enqueue export-invoices.
 *   5. Return { exportId, status: 'created' }.
 *
 * The worker is idempotent on exportId (compare-and-set on exports.status).
 * The API itself is idempotent on Idempotency-Key.
 */
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import {
  exports as exportsTable,
  exportItems,
  extractedInvoices,
  auditEvents,
} from "@/db/schema";
import { requirePermission } from "@/lib/rbac";
import { withIdempotency } from "@/lib/review/idempotencyWrap";
import { getQueue, JOB } from "@/lib/queue";

const BodySchema = z.object({
  format: z.enum(["csv", "json"]),
  extractedInvoiceIds: z.array(z.string().uuid()).min(1).max(500),
  clientId: z.string().uuid().nullable().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role, id: userId } = session.user;

  try {
    requirePermission(role, "invoice.export");
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 403 });
  }

  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  return withIdempotency(
    req,
    organizationId,
    "/api/ap/exports",
    body,
    async () => {
      return withOrg(organizationId, async (tx) => {
        // 1. Pre-flight: must all be approved + within this org.
        const candidates = await tx
          .select({
            id: extractedInvoices.id,
            reviewStatus: extractedInvoices.reviewStatus,
          })
          .from(extractedInvoices)
          .where(
            and(
              eq(extractedInvoices.organizationId, organizationId),
              inArray(extractedInvoices.id, body.extractedInvoiceIds),
            ),
          );

        const seen = new Set(candidates.map((c) => c.id));
        const missing = body.extractedInvoiceIds.filter((id) => !seen.has(id));
        const notApproved = candidates.filter((c) => c.reviewStatus !== "approved");
        if (missing.length > 0 || notApproved.length > 0) {
          return {
            status: 422,
            body: {
              error: "not_all_approved",
              message:
                "All invoices must be approved before export. Some are missing or not approved.",
              missing,
              notApproved: notApproved.map((c) => ({
                id: c.id,
                reviewStatus: c.reviewStatus,
              })),
            },
          };
        }

        // 2. Insert exports row.
        const [exp] = await tx
          .insert(exportsTable)
          .values({
            organizationId,
            clientId: body.clientId ?? null,
            format: body.format,
            itemCount: body.extractedInvoiceIds.length,
            createdBy: userId,
          })
          .returning({ id: exportsTable.id });

        // 3. Insert export_items.
        await tx.insert(exportItems).values(
          body.extractedInvoiceIds.map((id) => ({
            organizationId,
            exportId: exp.id,
            extractedInvoiceId: id,
          })),
        );

        await tx.insert(auditEvents).values({
          organizationId,
          actorType: "user",
          actorId: userId,
          action: "export.created",
          entityType: "export",
          entityId: exp.id,
          metadataJson: { format: body.format, itemCount: body.extractedInvoiceIds.length },
        });

        // 4. Enqueue worker — outside the tx is acceptable for pg-boss since
        // the worker is idempotent on exportId.
        const boss = await getQueue();
        await boss.send(
          JOB.exportInvoices,
          { exportId: exp.id, organizationId },
          { singletonKey: `export-invoices:${exp.id}` },
        );

        return {
          status: 201,
          body: { exportId: exp.id, status: "created" as const },
        };
      });
    },
  );
}
