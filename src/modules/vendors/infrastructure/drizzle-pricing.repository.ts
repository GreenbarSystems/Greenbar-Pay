/**
 * VendorPricingRepository implementation. Moved verbatim from
 * src/app/(app)/vendors/[id]/page.tsx (read side) and
 * src/jobs/recomputeVendorProfile.ts (write side — the append-only
 * supersede-then-insert pattern from PR6 review #4).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { extractedInvoiceLines, extractedInvoices, vendorPricingHistory } from "@/db/schema";
import type {
  InvoiceLineForPricing,
  PricingHistoryRow,
  VendorPricingRepository,
} from "../application/ports";
import type { KeywordStats } from "../domain/pricing-stats";

async function findActivePricingHistory(
  tx: Tx,
  vendorId: string,
  limit: number,
): Promise<PricingHistoryRow[]> {
  // Pricing history is append-only (PR6) — display only the active rows.
  return tx
    .select({
      id: vendorPricingHistory.id,
      itemKeyword: vendorPricingHistory.itemKeyword,
      avgUnitPrice: vendorPricingHistory.avgUnitPrice,
      samples: vendorPricingHistory.samples,
      lastSeenAt: vendorPricingHistory.lastSeenAt,
    })
    .from(vendorPricingHistory)
    .where(
      and(
        eq(vendorPricingHistory.vendorId, vendorId),
        isNull(vendorPricingHistory.supersededAt),
      ),
    )
    .orderBy(desc(vendorPricingHistory.samples))
    .limit(limit);
}

async function findApprovedInvoiceLines(
  tx: Tx,
  organizationId: string,
  invoiceIds: string[],
  limit: number,
): Promise<InvoiceLineForPricing[]> {
  // Most-recent-first + bounded fetch (see MAX_PRICING_LINE_ROWS in
  // domain/vendor.ts). The per-keyword cap (PRICING_SAMPLE_CAP) only
  // bounds memory AFTER this fetch completes — this bounds the fetch
  // itself. NULLS LAST for the same reason as the invoice scan: a line
  // item with no parent invoiceDate is skipped by the aggregation loop,
  // so it shouldn't be able to displace a real dated sample from the cap.
  return tx
    .select({
      description: extractedInvoiceLines.description,
      unitPrice: extractedInvoiceLines.unitPrice,
      invoiceDate: extractedInvoices.invoiceDate,
    })
    .from(extractedInvoiceLines)
    .innerJoin(
      extractedInvoices,
      eq(extractedInvoices.id, extractedInvoiceLines.extractedInvoiceId),
    )
    .where(
      and(
        eq(extractedInvoiceLines.organizationId, organizationId),
        inArray(extractedInvoiceLines.extractedInvoiceId, invoiceIds),
      ),
    )
    .orderBy(sql`${extractedInvoices.invoiceDate} DESC NULLS LAST`)
    .limit(limit);
}

async function supersedeAndInsert(
  tx: Tx,
  organizationId: string,
  vendorId: string,
  keyword: string,
  lastSeenAt: Date,
  stats: KeywordStats,
): Promise<void> {
  // PR6 — review #4: vendor_pricing_history is append-only. Soft-
  // supersede the active row (if any), then INSERT a fresh one. The
  // partial unique index uniq_vendor_pricing_active enforces at most
  // one active row per (vendor, keyword). Prior aggregates remain
  // queryable for the rate-drift validation rule and the evidence
  // packet.
  await tx
    .update(vendorPricingHistory)
    .set({ supersededAt: sql`now()` })
    .where(
      and(
        eq(vendorPricingHistory.vendorId, vendorId),
        eq(vendorPricingHistory.itemKeyword, keyword),
        sql`${vendorPricingHistory.supersededAt} is null`,
      ),
    );

  await tx.insert(vendorPricingHistory).values({
    organizationId,
    vendorId,
    itemKeyword: keyword,
    avgUnitPrice: stats.avg.toFixed(4),
    samples: stats.sampleCount,
    lastSeenAt,
    // Phase 9 — D3 stats. stddev is NULL below 2 samples so the
    // validator treats it as "insufficient data → no drift flag."
    stddevUnitPrice: stats.stddev === null ? null : stats.stddev.toFixed(4),
    minUnitPrice: stats.min.toFixed(4),
    maxUnitPrice: stats.max.toFixed(4),
    lastUnitPrice: stats.lastPrice.toFixed(4),
    priceTrend: stats.trend,
  });
}

export const drizzlePricingRepository: VendorPricingRepository = {
  findActivePricingHistory,
  findApprovedInvoiceLines,
  supersedeAndInsert,
};
