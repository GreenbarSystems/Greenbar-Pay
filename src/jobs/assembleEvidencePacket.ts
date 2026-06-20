/**
 * assemble-evidence-packet — Phase 11 D4.
 *
 * Trigger: `invoice.approved` (enqueued by the approve route after
 * commit). Idempotent on (org, extractedInvoiceId) via the UNIQUE
 * constraint — a duplicate delivery fails the INSERT but the audit
 * trail already records the first seal, so we treat ON CONFLICT DO
 * NOTHING as the no-op signal and exit cleanly.
 *
 * Steps:
 *   1. Inside withOrgAsWorker tx, run the pure assembler — Promise.all
 *      load of all pinned artifacts + sha256 over a canonical JSON.
 *   2. INSERT into evidence_packets with sealed_at = sql`now()`.
 *      Manifest_json carries the full audit-ready payload; the
 *      DB-level rule blocks any later UPDATE.
 *   3. Emit `evidence.packet_sealed` audit event with the packet id
 *      and manifest hash so an auditor can confirm the seal without
 *      joining evidence_packets.
 *
 * The PDF render step is deferred — Phase 11 ships the JSON manifest
 * only. A follow-up phase can read evidence_packets rows where
 * pdf_storage_key IS NULL and produce the PDF asynchronously without
 * needing any rework here.
 */
import type PgBoss from "pg-boss";
import { sql } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import { evidencePackets, auditEvents } from "@/db/schema";
import { assembleEvidenceManifest } from "@/lib/evidence/assemble";
import { scrubError } from "@/lib/llm/scrub";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

export async function handleAssembleEvidencePacket(
  job: PgBoss.Job<JobPayloads[typeof JOB.assembleEvidencePacket]>,
): Promise<void> {
  const { extractedInvoiceId, organizationId } = job.data;

  try {
    await withOrgAsWorker(organizationId, async (tx) => {
      const assembled = await assembleEvidenceManifest(tx, extractedInvoiceId);
      if (!assembled) {
        // The invoice or document was deleted between approve and the
        // job firing — extremely rare given the FK chain. Nothing to
        // do; let the retry policy give up.
        console.warn(
          `[assemble-evidence-packet] no artifacts for invoice=${extractedInvoiceId}; skipping`,
        );
        return;
      }

      const [inserted] = await tx
        .insert(evidencePackets)
        .values({
          organizationId,
          extractedInvoiceId,
          documentId: assembled.documentId,
          sealedAt: sql`now()`,
          sealedByUserId: assembled.sealedByUserId,
          manifestHash: assembled.manifestHash,
          manifestJson: assembled.manifest,
          sourceDocumentHash: assembled.sourceDocumentHash,
        })
        .onConflictDoNothing({
          target: [
            evidencePackets.organizationId,
            evidencePackets.extractedInvoiceId,
          ],
        })
        .returning({ id: evidencePackets.id });

      if (!inserted) {
        // Duplicate delivery — the packet was already sealed. The
        // first seal's audit event stands; no second seal event.
        return;
      }

      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "worker",
        action: "evidence.packet_sealed",
        entityType: "extracted_invoice",
        entityId: extractedInvoiceId,
        metadataJson: {
          evidencePacketId: inserted.id,
          manifestHash: assembled.manifestHash,
          sourceDocumentHash: assembled.sourceDocumentHash,
        },
      });
    });
  } catch (err) {
    console.error(
      "[assemble-evidence-packet]",
      scrubError(err).message,
    );
    throw err;
  }
}
