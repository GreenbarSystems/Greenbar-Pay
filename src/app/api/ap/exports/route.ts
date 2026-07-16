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
 *
 * RBAC (PR3 pattern, mirrors invoice.approve / invoice.edit): the org
 * role is a cheap fast path; if it doesn't grant invoice.export, every
 * distinct client among the SELECTED invoices must have an explicit
 * per-client grant for this user (§1.5 effective permission =
 * max(orgRole, clientRole)). Previously this route only checked the
 * org-wide role, which both over- and under-authorized: a clerk with
 * only a per-client `reviewer` grant on client X couldn't export that
 * client's invoices, and (once multi-client is unfrozen) a user with
 * org-wide export could export another client's invoices without any
 * per-client check at all — the first is the bug this closes.
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
  accountingConnections,
  auditEvents,
} from "@/db/schema";
import { can, loadEffectiveRole } from "@/lib/rbac";
import { withIdempotency } from "@/lib/review/idempotencyWrap";
import { getQueue, JOB } from "@/lib/queue";
import { isMultiClientEnabled } from "@/lib/featureFlags";

const BodySchema = z.object({
  format: z.enum(["csv", "json", "qbo", "xero"]),
  extractedInvoiceIds: z.array(z.string().uuid()).min(1).max(500),
  clientId: z.string().uuid().nullable().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role, id: userId } = session.user;

  // PR3 pattern — org-role fast path. If this doesn't grant, we defer
  // to the per-client lookup inside the tx once we know which clients
  // the selected invoices belong to (a blanket 403 here would wrongly
  // reject a user who only has a per-client export grant).
  const hasOrgPermission = can(role, "invoice.export");

  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  // Multi-client freeze (CLAUDE.md — see src/lib/featureFlags.ts). When
  // the flag is off, the product is solo-first: clientId from the
  // request body is silently coerced to null so an export cannot be
  // scoped to a client that solo mode does not surface.
  // When the freeze is later lifted, this guard becomes a no-op.
  if (!isMultiClientEnabled() && body.clientId != null) {
    body = { ...body, clientId: null };
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
            clientId: extractedInvoices.clientId,
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

        // PR3 — per-client RBAC. Solo mode (multi-client freeze) means
        // every candidate's clientId is null, which loadEffectiveRole
        // resolves straight to orgRole — this block is a no-op until
        // the freeze lifts. Once multi-client work resumes, a user
        // without org-wide export must hold an explicit grant on EVERY
        // client represented among the selected invoices; missing even
        // one fails the whole export (matches the all-or-nothing
        // not_all_approved check above).
        if (!hasOrgPermission) {
          const distinctClientIds = Array.from(
            new Set(candidates.map((c) => c.clientId)),
          );
          for (const clientId of distinctClientIds) {
            const effRole = await loadEffectiveRole(tx, {
              userId,
              clientId,
              orgRole: role,
            });
            if (!can(effRole, "invoice.export")) {
              return {
                status: 403,
                body: {
                  error: "forbidden",
                  message: clientId
                    ? `${effRole} lacks invoice.export for client ${clientId}`
                    : `${effRole} lacks invoice.export`,
                },
              };
            }
          }
        }

        // 2. For accounting sync formats, require an active connection.
        if (body.format === "qbo" || body.format === "xero") {
          const [conn] = await tx
            .select({ id: accountingConnections.id })
            .from(accountingConnections)
            .where(
              and(
                eq(accountingConnections.organizationId, organizationId),
                eq(accountingConnections.provider, body.format),
                eq(accountingConnections.isActive, true),
              ),
            )
            .limit(1);
          if (!conn) {
            return {
              status: 422,
              body: {
                error: "no_accounting_connection",
                message: `No active ${body.format.toUpperCase()} connection found. Connect via Settings > Integrations.`,
              },
            };
          }
        }

        // 3. Insert exports row.
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

        // 4. Insert export_items.
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

        // 5. Enqueue the appropriate worker — outside the tx is acceptable for
        // pg-boss since all workers are idempotent on exportId.
        const boss = await getQueue();
        if (body.format === "qbo") {
          await boss.send(
            JOB.syncToQbo,
            { exportId: exp.id, organizationId },
            { singletonKey: `sync-to-qbo:${exp.id}` },
          );
        } else if (body.format === "xero") {
          await boss.send(
            JOB.syncToXero,
            { exportId: exp.id, organizationId },
            { singletonKey: `sync-to-xero:${exp.id}` },
          );
        } else {
          await boss.send(
            JOB.exportInvoices,
            { exportId: exp.id, organizationId },
            { singletonKey: `export-invoices:${exp.id}` },
          );
        }

        return {
          status: 201,
          body: { exportId: exp.id, status: "created" as const },
        };
      });
    },
  );
}
