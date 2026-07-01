/**
 * DocumentRepository implementation. Moved verbatim from
 * src/lib/validation/run.ts (latest-extraction text length) and
 * src/jobs/validateExtractedInvoice.ts (document status compare-and-set).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { documentExtractions, documents } from "@/db/schema";
import type { DocumentRepository } from "../application/ports";

async function findLatestExtractionTextLength(
  tx: Tx,
  documentId: string,
): Promise<number | null> {
  const [latest] = await tx
    .select({ textLength: documentExtractions.textLength })
    .from(documentExtractions)
    .where(eq(documentExtractions.documentId, documentId))
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);
  return latest?.textLength ?? null;
}

type DocumentStatus = (typeof documents.$inferSelect)["status"];

async function updateStatusIfIn(
  tx: Tx,
  documentId: string,
  newStatus: string,
  allowedCurrent: string[],
): Promise<void> {
  await tx
    .update(documents)
    .set({ status: newStatus as DocumentStatus })
    .where(
      and(
        eq(documents.id, documentId),
        inArray(documents.status, allowedCurrent as DocumentStatus[]),
      ),
    );
}

export const drizzleDocumentRepository: DocumentRepository = {
  findLatestExtractionTextLength,
  updateStatusIfIn,
};
