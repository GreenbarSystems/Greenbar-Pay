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
import { exports as exportsTable } from "@/db/schema";
import { requirePermission } from "@/lib/rbac";
import { storage } from "@/lib/storage";

const SIGNED_URL_TTL_SECONDS = 120;

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
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

  const url = await storage.getSignedUrl(row.storageKey, SIGNED_URL_TTL_SECONDS);
  return NextResponse.redirect(url, 302);
}
