/**
 * VendorMatchWriteRepository implementation. Moved verbatim from
 * src/lib/validation/run.ts — append-only insert that keeps the
 * candidate-match history visible even as the resolved vendor changes
 * across revalidations.
 */
import type { Tx } from "@/db/client";
import { vendorMatches } from "@/db/schema";
import type { VendorMatchWriteInput, VendorMatchWriteRepository } from "../application/ports";

async function insert(tx: Tx, match: VendorMatchWriteInput): Promise<void> {
  await tx.insert(vendorMatches).values({
    organizationId: match.organizationId,
    extractedInvoiceId: match.extractedInvoiceId,
    vendorId: match.vendorId,
    matchConfidence: match.matchConfidence,
    matchScore: String(match.matchScore),
    matchMethod: match.matchMethod,
    candidatesJson: match.candidatesJson,
  });
}

export const drizzleVendorMatchWriteRepository: VendorMatchWriteRepository = {
  insert,
};
