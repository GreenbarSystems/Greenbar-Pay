/**
 * Phase 11 — D4: GET /api/ap/exports/evidence/:invoiceId
 *
 * Returns the audit-ready evidence packet manifest as JSON, with a
 * Content-Disposition: attachment header so browsers download it as
 * a file named `evidence-<invoiceId>.json`. RLS scopes the lookup to
 * the caller's org. The route returns 404 when no packet exists yet
 * (the assemble job is async, so a freshly-approved invoice may have
 * a small gap before the packet is available).
 *
 * No idempotency wrap — this is a read.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { evidencePackets, auditEvents } from "@/db/schema";
import { can } from "@/lib/rbac";
import { requireUuid } from "@/lib/route-helpers";

export async function GET(
  _req: Request,
  { params }: { params: { invoiceId: string } },
) {
  const bad = requireUuid(params.invoiceId);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId, role, id: userId } = session.user;

  // Read scope: anyone who can read an invoice can pull its evidence
  // packet. Per-client narrowing isn't relevant — RLS already filters
  // by org; if the user can read the invoice in the UI, they can read
  // the matching packet.
  if (!can(role, "invoice.read")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await withOrg(organizationId, async (tx) => {
    const [packet] = await tx
      .select({
        id: evidencePackets.id,
        manifestJson: evidencePackets.manifestJson,
        manifestHash: evidencePackets.manifestHash,
        sealedAt: evidencePackets.sealedAt,
      })
      .from(evidencePackets)
      .where(
        and(
          eq(evidencePackets.extractedInvoiceId, params.invoiceId),
          eq(evidencePackets.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!packet) return null;

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "user",
      actorId: userId,
      action: "evidence.packet_downloaded",
      entityType: "extracted_invoice",
      entityId: params.invoiceId,
      metadataJson: {
        evidencePacketId: packet.id,
        manifestHash: packet.manifestHash,
      },
    });

    return packet;
  });

  if (!result) {
    return NextResponse.json(
      {
        error: "not_ready",
        message:
          "Evidence packet not yet sealed for this invoice. The assemble job runs asynchronously after approval; retry in a few seconds.",
      },
      { status: 404 },
    );
  }

  // Pretty-printed JSON so a human auditor can read it directly when
  // the file is opened in a browser or editor.
  const body = JSON.stringify(
    {
      manifestHash: result.manifestHash,
      sealedAt: result.sealedAt?.toISOString() ?? null,
      manifest: result.manifestJson,
    },
    null,
    2,
  );

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="evidence-${params.invoiceId}.json"`,
      "Cache-Control": "private, no-store",
    },
  });
}
