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
import { documents } from "@/db/schema";
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

  // Insert document row first so we have an ID for the storage key. The
  // unique (organization_id, content_hash) index dedups (§4.1).
  const result = await withOrg(organizationId, async (tx) => {
    const existing = await tx.query.documents.findFirst({
      where: (d, { and, eq }) =>
        and(eq(d.organizationId, organizationId), eq(d.contentHash, inspected.contentHash)),
      columns: { id: true, status: true, storageKey: true },
    });

    if (existing) {
      return { dedup: true as const, document: existing };
    }

    const ext = EXT_BY_MIME[inspected.mimeType] ?? "bin";
    const [inserted] = await tx
      .insert(documents)
      .values({
        organizationId,
        clientId,
        source: "upload",
        originalFilename: file.name,
        mimeType: inspected.mimeType,
        // storageKey is populated below after we know the ID.
        storageKey: "pending",
        contentHash: inspected.contentHash,
        createdBy: userId,
      })
      .returning({ id: documents.id });

    const key = documentStorageKey({
      organizationId,
      documentId: inserted.id,
      extension: ext,
    });

    await tx
      .update(documents)
      .set({ storageKey: key })
      .where(eq(documents.id, inserted.id));

    return {
      dedup: false as const,
      document: { id: inserted.id, status: "received" as const, storageKey: key },
    };
  });

  if (!result.dedup) {
    await storage.putObject({
      key: result.document.storageKey,
      body: inspected.buf,
      contentType: inspected.mimeType,
    });

    // Enqueue extraction. Job is keyed on documentId — the handler's
    // compare-and-set on status makes duplicate deliveries safe (§4.4/§4.5).
    const boss = await getQueue();
    await boss.send(
      JOB.processDocument,
      { documentId: result.document.id, organizationId },
      { singletonKey: `process-document:${result.document.id}` },
    );
  }

  const body = {
    documentId: result.document.id,
    status: result.document.status,
    dedup: result.dedup,
  };

  if (idemKey) {
    await writeIdempotencyKey(organizationId, idemKey, requestHash, {
      status: result.dedup ? 200 : 201,
      body,
    });
  }

  return NextResponse.json(body, { status: result.dedup ? 200 : 201 });
}
