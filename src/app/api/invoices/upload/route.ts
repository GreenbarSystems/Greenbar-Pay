/**
 * POST /api/invoices/upload — manual invoice upload.
 *
 * Pipeline:
 *   1. Auth (Auth.js session).
 *   2. RBAC: invoice.upload permission required.
 *   3. Idempotency check (§4.6).
 *   4. File-safety gate (§2.6): size, MIME sniff, AV, qpdf sanitize.
 *   5. Object storage write.
 *   6. INSERT documents (org-scoped via withOrg → RLS enforced).
 *   7. Cache response on Idempotency-Key.
 *
 * OCR / LLM extraction lands in Phase 2 — for now status stays `received`.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { documents, auditEvents } from "@/db/schema";
import { requirePermission } from "@/lib/rbac";
import {
  inspectUpload,
  FileSafetyError,
  ALLOWED_MIME_TYPES,
  MAX_FILE_BYTES,
} from "@/lib/file-safety";
import { storage, documentStorageKey } from "@/lib/storage";
import {
  hashRequest,
  readIdempotencyKey,
  writeIdempotencyKey,
} from "@/lib/idempotency";
import { getQueue, JOB } from "@/lib/queue";

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/tiff": "tif",
};

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId, role, id: userId } = session.user;

  try {
    requirePermission(role, "invoice.upload");
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: (err as { status?: number }).status ?? 403 },
    );
  }

  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json(
      { error: "expected multipart/form-data" },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  const clientIdRaw = formData.get("clientId");
  const clientId =
    typeof clientIdRaw === "string" && clientIdRaw.length > 0 ? clientIdRaw : null;

  // Phase 9.5 — documentKind discriminator routes the upload to either
  // the invoice extraction pipeline (default) or the contract
  // extraction pipeline. The value lands on documents.kind and
  // process-document dispatches to the matching extractor.
  const documentKindRaw = formData.get("documentKind");
  const documentKind: "invoice" | "contract" =
    documentKindRaw === "contract" ? "contract" : "invoice";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing `file`" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "too_large", maxBytes: MAX_FILE_BYTES },
      { status: 413 },
    );
  }

  const idemKey = req.headers.get("Idempotency-Key");
  const buf = Buffer.from(await file.arrayBuffer());
  const requestHash = idemKey
    ? hashRequest("POST", "/api/invoices/upload", {
        filename: file.name,
        clientId,
        contentHash: Buffer.from(buf).toString("base64").slice(0, 64), // size-bounded
      })
    : "";

  if (idemKey) {
    const lookup = await readIdempotencyKey(organizationId, idemKey, requestHash);
    if (lookup.kind === "hit") {
      return NextResponse.json(lookup.response.body, {
        status: lookup.response.status,
      });
    }
    if (lookup.kind === "conflict") {
      return NextResponse.json(
        { error: "idempotency_key_conflict" },
        { status: 409 },
      );
    }
  }

  let inspected;
  try {
    inspected = await inspectUpload(buf);
  } catch (err) {
    if (err instanceof FileSafetyError) {
      return NextResponse.json(
        { error: err.code, message: err.message, allowed: ALLOWED_MIME_TYPES },
        { status: err.code === "too_large" ? 413 : 415 },
      );
    }
    throw err;
  }

  // PR3 — review #8/#9: insert is concurrent-safe and partial-failure-
  // recoverable.
  //
  //   #9: two simultaneous uploads of the same file used to lose one
  //       to a unique-violation 500. Now: ON CONFLICT DO NOTHING +
  //       refetch.
  //   #8: a doc whose first PUT failed mid-flight (row exists, bytes
  //       don't) used to be permanently stuck in `received` because
  //       the dedup branch always returned `dedup:true` with no
  //       repair. Now: if the existing row's status is still
  //       `received`, we treat the call as a repair — re-upload the
  //       bytes and re-enqueue process-document.
  //
  // The unique (organization_id, content_hash) index dedups (§4.1).
  const result = await withOrg(organizationId, async (tx) => {
    const ext = EXT_BY_MIME[inspected.mimeType] ?? "bin";

    // Attempt INSERT first; the unique-violation no-ops via ON CONFLICT.
    // If the row already exists (either pre-existing dedup OR a racing
    // first-writer), `inserted` is empty and we fall through to lookup.
    const inserted = await tx
      .insert(documents)
      .values({
        organizationId,
        clientId,
        source: "upload",
        kind: documentKind,
        originalFilename: file.name,
        mimeType: inspected.mimeType,
        storageKey: "pending",
        contentHash: inspected.contentHash,
        createdBy: userId,
      })
      .onConflictDoNothing({
        target: [documents.organizationId, documents.contentHash],
      })
      .returning({ id: documents.id });

    if (inserted.length > 0) {
      // First-writer path — we own the row. Populate the storage key
      // and emit the chain-of-custody event.
      const key = documentStorageKey({
        organizationId,
        documentId: inserted[0].id,
        extension: ext,
      });
      await tx
        .update(documents)
        .set({ storageKey: key })
        .where(eq(documents.id, inserted[0].id));

      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "user",
        actorId: userId,
        action: "document.uploaded",
        entityType: "document",
        entityId: inserted[0].id,
        metadataJson: {
          filename: file.name,
          contentHash: inspected.contentHash,
          mimeType: inspected.mimeType,
          byteSize: inspected.byteSize,
          clientId,
          // PR21 H6 — record the discriminator at upload time so an
          // auditor can prove what classification the document carried
          // before the extractor branch ran.
          documentKind,
        },
      });

      return {
        kind: "fresh" as const,
        document: { id: inserted[0].id, status: "received" as const, storageKey: key },
      };
    }

    // Conflict path — refetch the existing row and decide between true
    // dedup vs. partial-failure repair.
    const existing = await tx.query.documents.findFirst({
      where: (d, { and, eq }) =>
        and(eq(d.organizationId, organizationId), eq(d.contentHash, inspected.contentHash)),
      columns: { id: true, status: true, storageKey: true },
    });
    if (!existing) {
      // Vanishingly rare — would only happen if the dedup index
      // disagrees with the column lookup (corruption). Fail loud.
      throw new Error(
        `upload: ON CONFLICT fired but no existing row found for hash ${inspected.contentHash}`,
      );
    }

    const isRepairableStuck =
      existing.status === "received" &&
      (existing.storageKey === "pending" || existing.storageKey.length === 0);

    if (isRepairableStuck) {
      // The bytes never landed in storage on the first attempt.
      // Fix the storage_key (it may have been left as "pending") and
      // signal the caller to redo the putObject + enqueue. The audit
      // event records the repair so the duplicate retry isn't
      // misread as a fresh upload.
      const repairKey = documentStorageKey({
        organizationId,
        documentId: existing.id,
        extension: ext,
      });
      await tx
        .update(documents)
        .set({ storageKey: repairKey })
        .where(eq(documents.id, existing.id));

      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "user",
        actorId: userId,
        action: "document.upload_repaired",
        entityType: "document",
        entityId: existing.id,
        metadataJson: {
          filename: file.name,
          contentHash: inspected.contentHash,
          previousStorageKey: existing.storageKey,
        },
      });

      return {
        kind: "repair" as const,
        document: { id: existing.id, status: "received" as const, storageKey: repairKey },
      };
    }

    // True dedup — bytes are already there, processing is in flight
    // or complete. Record the resubmit attempt for the trail.
    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "user",
      actorId: userId,
      action: "document.upload_dedup",
      entityType: "document",
      entityId: existing.id,
      metadataJson: {
        filename: file.name,
        contentHash: inspected.contentHash,
        mimeType: inspected.mimeType,
        byteSize: inspected.byteSize,
        existingStatus: existing.status,
      },
    });
    return { kind: "dedup" as const, document: existing };
  });

  // Storage + enqueue happen for fresh uploads AND repairs. The job is
  // idempotent on documentId so a repair re-enqueue is safe even if the
  // first run is somehow still active in the queue.
  if (result.kind !== "dedup") {
    await storage.putObject({
      key: result.document.storageKey,
      body: inspected.buf,
      contentType: inspected.mimeType,
    });

    const boss = await getQueue();
    await boss.send(
      JOB.processDocument,
      { documentId: result.document.id, organizationId },
      { singletonKey: `process-document:${result.document.id}` },
    );
  }

  // Response shape: `dedup` boolean remains for client back-compat —
  // existing UploadForm checks it. `kind` is the precise outcome
  // ('fresh' | 'repair' | 'dedup') for any caller that wants to
  // distinguish a partial-failure recovery from a no-op resubmit.
  const httpStatus = result.kind === "fresh" ? 201 : 200;
  const body = {
    documentId: result.document.id,
    status: result.document.status,
    dedup: result.kind === "dedup",
    kind: result.kind,
  };

  if (idemKey) {
    await writeIdempotencyKey(organizationId, idemKey, requestHash, {
      status: httpStatus,
      body,
    });
  }

  return NextResponse.json(body, { status: httpStatus });
}
