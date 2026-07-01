/**
 * VendorCandidateRepository implementation. Moved verbatim from
 * src/lib/validation/run.ts's vendor-candidate load and the
 * scoreLinesAgainstVendorHistory helper's stats query.
 *
 * Deliberately independent of src/modules/vendors/infrastructure/* —
 * see the note in ../application/ports.ts on why this module owns its
 * own read against the `vendors`/`vendor_pricing_history` tables.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { vendorPricingHistory, vendors } from "@/db/schema";
import type { VendorCandidate } from "../domain/vendor-matching";
import type { LinePricingStats } from "../domain/line-scoring";
import type { VendorCandidateRepository } from "../application/ports";

async function findCandidates(
  tx: Tx,
  organizationId: string,
): Promise<VendorCandidate[]> {
  return tx
    .select({
      id: vendors.id,
      name: vendors.name,
      normalizedName: vendors.normalizedName,
      aliases: vendors.aliases,
    })
    .from(vendors)
    .where(eq(vendors.organizationId, organizationId));
}

async function findPricingStatsForKeywords(
  tx: Tx,
  vendorId: string,
  keywords: string[],
): Promise<Map<string, LinePricingStats>> {
  if (keywords.length === 0) return new Map();

  const statRows = await tx
    .select({
      itemKeyword: vendorPricingHistory.itemKeyword,
      avgUnitPrice: vendorPricingHistory.avgUnitPrice,
      stddevUnitPrice: vendorPricingHistory.stddevUnitPrice,
      samples: vendorPricingHistory.samples,
    })
    .from(vendorPricingHistory)
    .where(
      and(
        eq(vendorPricingHistory.vendorId, vendorId),
        isNull(vendorPricingHistory.supersededAt),
        inArray(vendorPricingHistory.itemKeyword, keywords),
      ),
    );

  const statsByKeyword = new Map<string, LinePricingStats>();
  for (const r of statRows) {
    statsByKeyword.set(r.itemKeyword, {
      sampleCount: r.samples,
      avgUnitPrice: Number(r.avgUnitPrice),
      stddevUnitPrice: r.stddevUnitPrice === null ? null : Number(r.stddevUnitPrice),
    });
  }
  return statsByKeyword;
}

export const drizzleVendorCandidateRepository: VendorCandidateRepository = {
  findCandidates,
  findPricingStatsForKeywords,
};
