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
import { and, eq, isNull, inArray, or } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { evidencePackets, extractedInvoices, auditEvents } from "@/db/schema";
import { can } from "@/lib/rbac";
import { loadPermittedClientIds } from "@/lib/rbac/client-scope";
import { requireUuid } from "@/lib/route-helpers";
import { getQueue, JOB } from "@/lib/queue";
import { scrubError } from "@/lib/llm/scrub";

export async function GET(
  req: Request,
  { params }: { params: { invoiceId: string } },
) {
  const bad = requireUuid(params.invoiceId);
  if (bad) return bad;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId, role, id: userId } = session.user;

  if (!can(role, "invoice.read")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await withOrg(organizationId, async (tx) => {
    // PR16 H2 — per-client read scope. Without this a viewer/clerk
    // with explicit per-client grants could pull the FULL packet
    // (vendor PII, history, override justification) for any invoice
    // in the org regardless of their client grants. Same loadPermitted
    // ClientIds pattern PR6 added to the vendor pages. Owner/admin/
    // reviewer get org-wide; clerk/viewer narrow by user_client_access.
    const permitted = await loadPermittedClientIds(tx, {
      userId,
      orgRole: role,
    });
    const clientFilter =
      permitted === null
        ? undefined
        : permitted.length === 0
          ? isNull(extractedInvoices.clientId)
          : or(
              isNull(extractedInvoices.clientId),
              inArray(extractedInvoices.clientId, permitted),
            );

    const [packet] = await tx
      .select({
        id: evidencePackets.id,
        manifestJson: evidencePackets.manifestJson,
        manifestHash: evidencePackets.manifestHash,
        sealedAt: evidencePackets.sealedAt,
      })
      .from(evidencePackets)
      .innerJoin(
        extractedInvoices,
        eq(extractedInvoices.id, evidencePackets.extractedInvoiceId),
      )
      .where(
        clientFilter
          ? and(
              eq(evidencePackets.extractedInvoiceId, params.invoiceId),
              eq(evidencePackets.organizationId, organizationId),
              clientFilter,
            )
          : and(
              eq(evidencePackets.extractedInvoiceId, params.invoiceId),
              eq(evidencePackets.organizationId, organizationId),
            ),
      )
      .limit(1);
    // 404 over 403 on the per-client miss — leaks no signal about
    // whether the invoice exists in a client the user can't see.
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
        // PR15 M-IP-UA — chain-of-custody attribution. The override
        // ledger already captures these at write time; the read side
        // needs them too so an auditor can prove who pulled the full
        // payload and from where.
        ipAddress:
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
      },
    });

    return packet;
  });

  if (!result) {
    // PR15 H-Evidence-Capture — when no packet exists for an approved
    // invoice (post-approval enqueue lost to a transient pg-boss
    // outage, prior bug, etc.), re-enqueue the assemble job from the
    // read path. Cheap: pg-boss `singletonKey` collapses any inflight
    // duplicates. Without this, the approve route's fire-and-forget
    // try/catch is the only retry surface, so a single dropped
    // enqueue left the invoice permanently without an evidence
    // packet — directly contradicting §D4.
    try {
      const boss = await getQueue();
      await boss.send(
        JOB.assembleEvidencePacket,
        { extractedInvoiceId: params.invoiceId, organizationId },
        {
          singletonKey: `assemble-evidence-packet:${params.invoiceId}`,
        },
      );
    } catch (err) {
      console.warn(
        `[evidence GET] re-enqueue failed for invoice=${params.invoiceId}; client retry will trigger again`,
        scrubError(err),
      );
    }
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

  // PR16 M-Filename — use the manifest hash prefix as a stable opaque
  // identifier instead of the invoice UUID. The UUID is internal and
  // appearing in download history / filesystem / forwarded emails
  // gives an unnecessary link back to the row for anyone with read
  // access. The hash prefix is auditor-friendly (matches the
  // manifestHash field inside the file) without exposing the join key.
  const filename = `evidence-${result.manifestHash.slice(0, 12)}.json`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
