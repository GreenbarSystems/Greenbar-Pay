/**
 * GET /api/ap/exports/:id/download — redirect to a short-lived signed URL.
 *
 * Refuses if the export isn't `completed` (404 → run was lost or failed)
 * or if the storage_key is null. RLS scopes the lookup to the caller's org.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { exports as exportsTable, auditEvents } from "@/db/schema";
import { requirePermission } from "@/lib/rbac";
import { storage } from "@/lib/storage";
import { requireUuid } from "@/lib/route-helpers";

const SIGNED_URL_TTL_SECONDS = 120;

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { organizationId, role } = session.user;

  try {
    requirePermission(role, "invoice.export");
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 403 });
  }

  const row = await withOrg(organizationId, async (tx) => {
    const [r] = await tx
      .select({
        id: exportsTable.id,
        status: exportsTable.status,
        storageKey: exportsTable.storageKey,
        format: exportsTable.format,
      })
      .from(exportsTable)
      .where(
        and(
          eq(exportsTable.id, params.id),
          eq(exportsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return r ?? null;
  });

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "completed" || !row.storageKey) {
    return NextResponse.json(
      { error: "not_ready", status: row.status },
      { status: 409 },
    );
  }

  // PR2 — review #21: an auditor needs to know who pulled an export and
  // when. Wrapped in try/catch so an audit-row failure cannot break the
  // download — the cost of a missed audit row is preferable to denying
  // the download. (If DB writes start failing here, that's its own alert.)
  try {
    await withOrg(organizationId, async (tx) => {
      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "user",
        actorId: session.user.id,
        action: "export.downloaded",
        entityType: "export",
        entityId: params.id,
        metadataJson: {
          format: row.format,
          ttlSeconds: SIGNED_URL_TTL_SECONDS,
        },
      });
    });
  } catch (err) {
    console.warn(
      `[export-download] audit insert failed for export=${params.id}; proceeding with redirect`,
    );
  }

  const url = await storage.getSignedUrl(row.storageKey, SIGNED_URL_TTL_SECONDS);
  return NextResponse.redirect(url, 302);
}
