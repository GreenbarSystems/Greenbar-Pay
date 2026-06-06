/**
 * Ingest one inbound email (addendum §3.3).
 *
 *   1. Fetch raw .eml from object storage.
 *   2. Compute idempotency key = sha256(Message-ID || s3_key).
 *   3. INSERT email_messages ... ON CONFLICT DO NOTHING. If conflict,
 *      the message was already processed — return immediately.
 *   4. Resolve (org, client) from the recipient address. Unresolved →
 *      status='unrouted', no attachments written.
 *   5. For each MIME part: write email_attachments. Accepted parts
 *      additionally write a documents row and enqueue process-document.
 *   6. Update email_messages.status to processed / no_attachments /
 *      unrouted / failed.
 *
 * Idempotency property: re-running with the same S3 object key produces
 * exactly the same set of rows.
 *
 * RLS note: the email-message lookup runs with the GUC unset (admin
 * pool) so we can detect duplicates that arrived against a different
 * org. The subsequent inserts run under the resolved org's GUC.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { rawAdminDb } from "@/db/internal/rawClient";
import { withOrgAsWorker } from "@/db/client";
import {
  emailMessages,
  emailAttachments,
  documents,
  organizations,
  clients,
  auditEvents,
} from "@/db/schema";
import { storage, documentStorageKey } from "@/lib/storage";
import { parseEml, type ParsedEmail, type ParsedAttachment } from "./parse";
import { parseInboxAddress } from "./address";
import { getQueue, JOB } from "@/lib/queue";
import { scrubError } from "@/lib/llm/scrub";

const PROVIDER = "ses"; // V1 — Phase 6 only wires SES. Extend with a router later.

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/tiff": "tif",
};

export interface IngestInput {
  /** S3 key of the raw RFC 822 .eml. */
  rawMessageStorageKey: string;
  /** The mailbox the message arrived at — used as the indexed lookup key. */
  mailbox: string;
}

export type IngestResult =
  | { kind: "duplicate"; emailMessageId: string }
  | {
      kind: "ingested";
      emailMessageId: string;
      status: "processed" | "no_attachments" | "unrouted" | "failed";
      acceptedDocumentIds: string[];
    };

export async function ingestEmlMessage(input: IngestInput): Promise<IngestResult> {
  // 1. Fetch and parse.
  const emlBytes = await storage.getObject(input.rawMessageStorageKey);
  const parsed = await parseEml(emlBytes);

  // 2. Idempotency key.
  const providerMessageId = createHash("sha256")
    .update(parsed.messageId || "")
    .update("\n")
    .update(input.rawMessageStorageKey)
    .digest("hex");

  // 3. Resolve route. We do this before the INSERT so the row carries the
  //    correct organization_id from the start — RLS-clean.
  const routing = resolveRoute(parsed.recipients);
  const resolution =
    routing === null
      ? null
      : await resolveOrgClient(routing.orgSlug, routing.clientSlug);

  const messageRowId = randomUUID();
  const orgId = resolution?.organizationId ?? null;
  const clientId = resolution?.clientId ?? null;

  // 4. Claim via INSERT ... ON CONFLICT DO NOTHING. Runs as worker (no GUC)
  //    — RLS WITH CHECK allows organization_id IS NULL for unrouted rows
  //    and equality otherwise.
  const inserted = await rawAdminDb
    .insert(emailMessages)
    .values({
      id: messageRowId,
      organizationId: orgId,
      clientId,
      provider: PROVIDER,
      providerMessageId,
      rawMessageStorageKey: input.rawMessageStorageKey,
      routingAddress: routing?.raw ?? "(unrouted)",
      mailbox: input.mailbox,
      fromEmail: parsed.from.email,
      fromName: parsed.from.name,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      receivedAt: parsed.receivedAt,
      status: "processing",
    })
    .onConflictDoNothing({
      target: [emailMessages.provider, emailMessages.providerMessageId],
    })
    .returning({ id: emailMessages.id });

  if (inserted.length === 0) {
    // Duplicate delivery — find the original and return.
    const [existing] = await rawAdminDb
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.provider, PROVIDER),
          eq(emailMessages.providerMessageId, providerMessageId),
        ),
      )
      .limit(1);
    return { kind: "duplicate", emailMessageId: existing?.id ?? "(unknown)" };
  }

  const emailMessageId = inserted[0].id;

  // 5. Unrouted → finalize and exit.
  if (!resolution) {
    await rawAdminDb
      .update(emailMessages)
      .set({
        status: "unrouted",
        statusReason: routing
          ? `no org/client matches ${routing.orgSlug}/${routing.clientSlug}`
          : "no recipient matched ap+org--client@ scheme",
        processedAt: sql`now()`,
      })
      .where(eq(emailMessages.id, emailMessageId));
    return {
      kind: "ingested",
      emailMessageId,
      status: "unrouted",
      acceptedDocumentIds: [],
    };
  }

  // 6. Routed: write attachments + documents under the resolved org.
  const acceptedDocumentIds: string[] = [];
  try {
    await withOrgAsWorker(resolution.organizationId, async (tx) => {
      let accepted = 0;

      for (const att of parsed.attachments) {
        const attachmentRowId = randomUUID();
        const accepted_ = att.inspected !== null;

        // Always record the attachment so audit + DLQ telemetry has it.
        await tx.insert(emailAttachments).values({
          id: attachmentRowId,
          organizationId: resolution.organizationId,
          emailMessageId,
          filename: att.filename,
          mimeType: att.headerMimeType,
          sniffedMimeType: att.inspected?.mimeType ?? null,
          storageKey: accepted_
            ? "" // Filled in below once we know the documentId.
            : `(rejected:${att.rejectionCode ?? "unknown"})`,
          fileSizeBytes: att.inspected?.byteSize ?? att.bytes.length,
          contentHash: att.inspected?.contentHash ?? null,
          status: accepted_ ? "accepted" : "rejected",
          rejectionReason: att.rejectionReason,
        });

        if (!accepted_) continue;
        const inspected = att.inspected!;

        // Dedup: same content_hash in the org collapses to one document.
        const existing = await tx
          .select({ id: documents.id, storageKey: documents.storageKey })
          .from(documents)
          .where(
            and(
              eq(documents.organizationId, resolution.organizationId),
              eq(documents.contentHash, inspected.contentHash),
            ),
          )
          .limit(1);

        let documentId: string;
        let documentStorageKey_: string;

        if (existing[0]) {
          documentId = existing[0].id;
          documentStorageKey_ = existing[0].storageKey;
        } else {
          const ext = EXT_BY_MIME[inspected.mimeType] ?? "bin";
          const newId = randomUUID();
          documentStorageKey_ = documentStorageKey({
            organizationId: resolution.organizationId,
            documentId: newId,
            extension: ext,
          });
          await tx.insert(documents).values({
            id: newId,
            organizationId: resolution.organizationId,
            clientId: resolution.clientId,
            emailMessageId,
            emailAttachmentId: attachmentRowId,
            source: "email",
            originalFilename: att.filename,
            mimeType: inspected.mimeType,
            storageKey: documentStorageKey_,
            contentHash: inspected.contentHash,
          });
          documentId = newId;
          acceptedDocumentIds.push(documentId);

          // Write the document file to storage AFTER the DB row exists so a
          // partial failure leaves no orphan.
          await storage.putObject({
            key: documentStorageKey_,
            body: inspected.buf,
            contentType: inspected.mimeType,
          });
        }

        // Backfill the attachment row's storage_key to point at the doc file.
        await tx
          .update(emailAttachments)
          .set({ storageKey: documentStorageKey_ })
          .where(eq(emailAttachments.id, attachmentRowId));

        accepted += 1;
      }

      await tx
        .update(emailMessages)
        .set({
          status: accepted > 0 ? "processed" : "no_attachments",
          statusReason:
            accepted === 0 ? "no valid attachment in MIME tree" : null,
          processedAt: sql`now()`,
        })
        .where(eq(emailMessages.id, emailMessageId));

      await tx.insert(auditEvents).values({
        organizationId: resolution.organizationId,
        actorType: "worker",
        action: "email.ingested",
        entityType: "email_message",
        entityId: emailMessageId,
        metadataJson: {
          from: parsed.from.email,
          subject: parsed.subject?.slice(0, 200) ?? null,
          attachmentCount: parsed.attachments.length,
          acceptedCount: accepted,
        },
      });
    });
  } catch (err) {
    // Scrub before persisting — parse / storage errors can carry filenames
    // or other content fragments (§2.4 applies to DB writes too once the
    // value is surfaced anywhere).
    const scrubbedMessage = scrubError(err).message.slice(0, 500);
    await rawAdminDb
      .update(emailMessages)
      .set({
        status: "failed",
        statusReason: scrubbedMessage,
        processedAt: sql`now()`,
      })
      .where(eq(emailMessages.id, emailMessageId));
    throw err;
  }

  // Enqueue process-document for each new doc — outside the tx for the
  // same reason as Phase 5: the worker job is idempotent on documentId.
  if (acceptedDocumentIds.length > 0) {
    const boss = await getQueue();
    for (const documentId of acceptedDocumentIds) {
      await boss.send(
        JOB.processDocument,
        { documentId, organizationId: resolution.organizationId },
        { singletonKey: `process-document:${documentId}` },
      );
    }
  }

  return {
    kind: "ingested",
    emailMessageId,
    status: acceptedDocumentIds.length > 0 ? "processed" : "no_attachments",
    acceptedDocumentIds,
  };
}

function resolveRoute(recipients: string[]) {
  for (const r of recipients) {
    const parsed = parseInboxAddress(r);
    if (parsed) return parsed;
  }
  return null;
}

async function resolveOrgClient(
  orgSlug: string,
  clientSlug: string,
): Promise<{ organizationId: string; clientId: string } | null> {
  const [org] = await rawAdminDb
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1);
  if (!org) return null;

  const [client] = await rawAdminDb
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.organizationId, org.id), eq(clients.slug, clientSlug)))
    .limit(1);
  if (!client) return null;

  return { organizationId: org.id, clientId: client.id };
}
