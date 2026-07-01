/**
 * VendorContractsRepository implementation. Moved verbatim from
 * src/app/(app)/vendors/[id]/page.tsx (Phase 9.5 PR4 — D3 second
 * half). Contracts/rate-cards arguably deserve their own bounded
 * context eventually (see migration plan); for this pass they're kept
 * as a repository the vendors module owns, mirroring exactly what the
 * detail page already queried.
 */
import { and, eq, desc } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { vendorContractLines, vendorContracts } from "@/db/schema";
import type {
  VendorContractLineRow,
  VendorContractRow,
  VendorContractsRepository,
} from "../application/ports";

async function findContractsForVendor(
  tx: Tx,
  organizationId: string,
  vendorId: string,
  limit: number,
): Promise<VendorContractRow[]> {
  // Explicit projection keeps the wire shape narrow and stable —
  // dropping unstable internal fields (llm_run_id, warnings_json).
  return tx
    .select({
      id: vendorContracts.id,
      status: vendorContracts.status,
      contractNumber: vendorContracts.contractNumber,
      effectiveDate: vendorContracts.effectiveDate,
      expiryDate: vendorContracts.expiryDate,
      paymentTerms: vendorContracts.paymentTerms,
      currency: vendorContracts.currency,
      confidence: vendorContracts.confidence,
      earlyPaymentDiscountPct: vendorContracts.earlyPaymentDiscountPct,
      earlyPaymentDiscountDays: vendorContracts.earlyPaymentDiscountDays,
      documentId: vendorContracts.documentId,
      createdAt: vendorContracts.createdAt,
      supersededAt: vendorContracts.supersededAt,
    })
    .from(vendorContracts)
    .where(
      and(
        eq(vendorContracts.organizationId, organizationId),
        eq(vendorContracts.vendorId, vendorId),
      ),
    )
    .orderBy(desc(vendorContracts.createdAt))
    .limit(limit);
}

async function findActiveContractLines(
  tx: Tx,
  contractId: string,
): Promise<VendorContractLineRow[]> {
  // PR21 H1 — caller gates this call behind invoice.override; unit_price
  // + notes are negotiated commercial terms that shouldn't reach every
  // viewer/reviewer role. Enforced by the get-vendor-detail use case,
  // not here — this repository just fetches what it's asked for.
  return tx
    .select({
      id: vendorContractLines.id,
      description: vendorContractLines.description,
      itemKeyword: vendorContractLines.itemKeyword,
      unitPrice: vendorContractLines.unitPrice,
      currency: vendorContractLines.currency,
      priceBasis: vendorContractLines.priceBasis,
      minQuantity: vendorContractLines.minQuantity,
      maxQuantity: vendorContractLines.maxQuantity,
      notes: vendorContractLines.notes,
    })
    .from(vendorContractLines)
    .where(eq(vendorContractLines.contractId, contractId))
    .orderBy(vendorContractLines.description);
}

export const drizzleVendorContractsRepository: VendorContractsRepository = {
  findContractsForVendor,
  findActiveContractLines,
};
