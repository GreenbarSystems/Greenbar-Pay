/**
 * GET /api/ap/review/:extractedInvoiceId/file-url — re-issue a fresh
 * signed URL for the underlying document.
 *
 * Why this exists: the review detail page (RSC) generates a 120-second
 * signed URL and embeds it in the rendered HTML. If a reviewer leaves
 * the page open for more than two minutes, the URL expires silently —
 * the PdfViewer reports a load error, and the iframe fallback would
 * also serve an expired URL. This endpoint lets the client refetch a
 * fresh URL without a full page reload (which would discard unsaved
 * form edits).
 *
 * Auth: invoice.read permission. RLS scopes by organization_id via
 * withOrg. Same TTL as the page-render path (120s) to keep the
 * URL-leak window consistent.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { extractedInvoices, documents } from "@/db/schema";
import { storage } from "@/lib/storage";
import { requirePermission } from "@/lib/rbac";
import { requireUuid } from "@/lib/route-helpers";

const SIGNED_URL_TTL_SECONDS = 120;

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const bad = requireUuid(params.id);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId, role } = session.user;

  try {
    requirePermission(role, "invoice.read");
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 403 },
    );
  }

  const result = await withOrg(organizationId, async (tx) => {
    const rows = await tx
      .select({ storageKey: documents.storageKey })
      .from(extractedInvoices)
      .innerJoin(documents, eq(documents.id, extractedInvoices.documentId))
      .where(eq(extractedInvoices.id, params.id))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!result) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = await storage.getSignedUrl(
    result.storageKey,
    SIGNED_URL_TTL_SECONDS,
  );
  return NextResponse.json({
    url,
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });
}
