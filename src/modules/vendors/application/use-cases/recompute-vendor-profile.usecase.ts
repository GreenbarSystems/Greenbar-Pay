/**
 * Use case: recompute-vendor-profile (Phase 7 — D1). Moved out of
 * src/jobs/recomputeVendorProfile.ts, which is now a thin pg-boss
 * adapter that unwraps the job payload, opens the worker transaction,
 * and calls this function. All business logic — aggregation, pricing-
 * keyword grouping, duplicate-submission counting — is unchanged from
 * the original job body; only the DB reads/writes now go through the
 * repository ports instead of inline Drizzle calls.
 *
 * Idempotent on vendorId: re-running aggregates the same approved
 * invoices and writes the same numbers. A per-vendor advisory lock
 * (VendorRepository.lockForRecompute) prevents two concurrent
 * recomputes from racing on the same vendor.
 */
import type { Tx } from "@/db/client";
import {
  MAX_PRICING_LINE_ROWS,
  MAX_VENDOR_INVOICE_ROWS,
  PRICING_SAMPLE_CAP,
  VENDOR_PROFILE_READY_THRESHOLD,
} from "../../domain/vendor";
import { aggregateVendorProfile } from "../../domain/profile-aggregation";
import { computeKeywordStats, truncateToMostRecent } from "../../domain/pricing-stats";
import { itemKeyword } from "@/modules/shared/kernel/item-keyword";
import type {
  VendorAuditRepository,
  VendorPricingRepository,
  VendorRepository,
} from "../ports";

export interface RecomputeVendorProfileInput {
  organizationId: string;
  vendorId: string;
}

export interface RecomputeVendorProfileDeps {
  vendorRepository: VendorRepository;
  pricingRepository: VendorPricingRepository;
  auditRepository: VendorAuditRepository;
  /** Injected for testability; defaults to the wall clock. */
  now?: () => Date;
}

interface KeywordSeries {
  prices: number[];
  dates: Date[];
  latest: Date;
  latestPrice: number;
}

export async function recomputeVendorProfile(
  tx: Tx,
  deps: RecomputeVendorProfileDeps,
  input: RecomputeVendorProfileInput,
): Promise<void> {
  const { organizationId, vendorId } = input;
  const now = (deps.now ?? (() => new Date()))();

  await deps.vendorRepository.lockForRecompute(tx, vendorId);

  const vendor = await deps.vendorRepository.findForRecompute(
    tx,
    organizationId,
    vendorId,
  );
  if (!vendor) return;

  // 1. Approved (and exported) invoices for this vendor, matched by
  // normalized name or alias. See findVendorInvoicesForRecompute for
  // the full PR13 rationale on why this single query serves both the
  // header-stats aggregation and the duplicate-pattern tally below.
  const allVendorInvoices = await deps.vendorRepository.findVendorInvoicesForRecompute(
    tx,
    organizationId,
    vendorId,
    MAX_VENDOR_INVOICE_ROWS,
  );

  const invoiceRows = allVendorInvoices.filter(
    (r) => r.reviewStatus === "approved" || r.reviewStatus === "exported",
  );

  if (invoiceRows.length === 0) {
    await deps.vendorRepository.markProfileUpdatedOnly(tx, vendorId);
    return;
  }

  // 2. Aggregate header-level stats (spend windows, terms drift, mode
  // payment terms) — pure function, see domain/profile-aggregation.ts.
  const aggregate = aggregateVendorProfile(invoiceRows, now);

  // 3. PR5 — review C4: duplicate_submission_count — count DISTINCT
  // invoices from this vendor (ANY review_status, including rejected
  // and superseded) that ever carried a duplicate_invoice finding.
  const allVendorInvoiceIds = allVendorInvoices.map((r) => r.id);
  const dupCount = await deps.vendorRepository.countDuplicateSubmissions(
    tx,
    organizationId,
    allVendorInvoiceIds,
  );

  await deps.vendorRepository.updateProfileStats(tx, vendorId, {
    invoiceCount: aggregate.invoiceCount,
    lastInvoiceDate: aggregate.lastInvoiceDate,
    spend30d: aggregate.spend30d,
    spend90d: aggregate.spend90d,
    avgInvoiceAmount: aggregate.avgInvoiceAmount,
    duplicateSubmissionCount: dupCount,
    termsDriftDetected: aggregate.termsDrift,
    // PR5 — review C5: only update the default once we have enough
    // samples (>= VENDOR_PROFILE_READY_THRESHOLD) so a single outlier
    // doesn't flip it.
    ...(aggregate.invoiceCount >= VENDOR_PROFILE_READY_THRESHOLD &&
    aggregate.modeTerms !== null
      ? { defaultPaymentTerms: aggregate.modeTerms }
      : {}),
  });

  // 4. Pricing history. Aggregate line items by normalized keyword —
  // only from the approved/exported invoices feeding the header stats,
  // never from rejected or superseded invoices (PR9 hotfix).
  const approvedInvoiceIds = invoiceRows.map((r) => r.id);
  const lineRows = await deps.pricingRepository.findApprovedInvoiceLines(
    tx,
    organizationId,
    approvedInvoiceIds,
    MAX_PRICING_LINE_ROWS,
  );

  // Phase 9 — D3: keep the full price series per keyword so we can
  // compute stddev / min / max / last / trend, not just the running
  // average. Bounded per keyword by PRICING_SAMPLE_CAP below.
  const grouped = new Map<string, KeywordSeries>();
  for (const r of lineRows) {
    if (r.unitPrice === null) continue;
    const keyword = itemKeyword(r.description);
    if (!keyword) continue;
    const price = Number(r.unitPrice);
    if (!Number.isFinite(price)) continue;

    const date = r.invoiceDate ? new Date(`${r.invoiceDate}T00:00:00Z`) : now;
    const existing = grouped.get(keyword);
    if (existing) {
      existing.prices.push(price);
      existing.dates.push(date);
      if (date > existing.latest) {
        existing.latest = date;
        existing.latestPrice = price;
      }
    } else {
      grouped.set(keyword, { prices: [price], dates: [date], latest: date, latestPrice: price });
    }
  }

  // PR6 — review #4: vendor_pricing_history is append-only. For every
  // (vendor, keyword) computed this run: soft-supersede the active row,
  // then insert a fresh one.
  for (const [keyword, agg] of grouped) {
    truncateToMostRecent(agg, PRICING_SAMPLE_CAP);
    // PR13 — truncateToMostRecent guarantees date-ascending order; tell
    // computeKeywordStats so the trend block skips its own re-sort.
    const stats = computeKeywordStats({ ...agg, presorted: true });
    await deps.pricingRepository.supersedeAndInsert(
      tx,
      organizationId,
      vendorId,
      keyword,
      agg.latest,
      stats,
    );
  }

  await deps.auditRepository.recordProfileRecomputed(tx, {
    organizationId,
    vendorId,
    invoiceCount: aggregate.invoiceCount,
    spend30d: aggregate.spend30d,
    spend90d: aggregate.spend90d,
    termsDriftDetected: aggregate.termsDrift,
    duplicateSubmissionCount: dupCount,
    pricingKeywords: grouped.size,
  });
}
