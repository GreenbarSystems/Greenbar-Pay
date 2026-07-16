/**
 * Separation-of-duties check shared by the approve and reject routes.
 *
 * The user who uploaded a document cannot also approve or reject the
 * extracted invoice — maker-checker enforced at the service layer
 * because the RBAC role does not distinguish upload from approve/reject.
 *
 * Returns { parentDoc, denial: null } when the check passes, or
 * { parentDoc, denial: <403 body> } (already audited) when it fires.
 * Callers return the denial immediately; parentDoc is still available
 * in the pass-through case for the caller's own final audit event.
 */
import { eq } from "drizzle-orm";
import { auditEvents, documents } from "@/db/schema";
import type { Tx } from "@/db/client";

export interface SodDenial {
  status: 403;
  body: { error: "sod_violation"; message: string };
}

export interface SodResult {
  parentDoc: { id: string; createdBy: string | null } | undefined;
  denial: SodDenial | null;
}

export async function checkSod(
  tx: Tx,
  opts: {
    organizationId: string;
    userId: string;
    documentId: string;
    invoiceId: string;
    attemptedAction: "approve" | "reject";
  },
): Promise<SodResult> {
  const [parentDoc] = await tx
    .select({ id: documents.id, createdBy: documents.createdBy })
    .from(documents)
    .where(eq(documents.id, opts.documentId))
    .limit(1);

  if (!parentDoc?.createdBy || parentDoc.createdBy !== opts.userId) {
    return { parentDoc, denial: null };
  }

  // PR6 — SoD denial audit. A SOX-style auditor needs evidence the
  // control fired; a silent 403 leaves the operation invisible.
  // Insert BEFORE the return so the event is captured in the same tx.
  await tx.insert(auditEvents).values({
    organizationId: opts.organizationId,
    actorType: "user",
    actorId: opts.userId,
    action: "invoice.sod_denied",
    entityType: "extracted_invoice",
    entityId: opts.invoiceId,
    metadataJson: {
      attemptedAction: opts.attemptedAction,
      uploaderId: parentDoc.createdBy,
    },
  });

  return {
    parentDoc,
    denial: {
      status: 403,
      body: {
        error: "sod_violation",
        message:
          opts.attemptedAction === "approve"
            ? "The user who uploaded this document cannot approve it. Ask a second reviewer."
            : "The user who uploaded this document cannot reject it. Ask a second reviewer.",
      },
    },
  };
}
