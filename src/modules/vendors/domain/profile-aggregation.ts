/**
 * Vendor profile aggregation — the header-stats half of
 * recompute-vendor-profile (Phase 7 — D1). Extracted verbatim from
 * src/jobs/recomputeVendorProfile.ts as a pure function: no DB, no
 * transaction, no I/O. This is the same computation the job ran inline
 * inside its `withOrgAsWorker` callback; pulling it out means it can be
 * unit-tested directly instead of only indirectly through a job that
 * needs a live Postgres transaction to exercise at all.
 */
import { VENDOR_PROFILE_READY_THRESHOLD } from "./vendor";

export interface VendorInvoiceForAggregation {
  total: string | null;
  invoiceDate: string | null;
  paymentTerms: string | null;
}

export interface VendorProfileAggregate {
  invoiceCount: number;
  lastInvoiceDate: string | null;
  spend30d: number;
  spend90d: number;
  avgInvoiceAmount: number;
  /**
   * PR5 — review C5: terms_drift is the MODE of payment_terms across all
   * approved invoices vs. the latest invoice's terms, not a frozen
   * first-seen default. Only meaningful at invoiceCount >=
   * VENDOR_PROFILE_READY_THRESHOLD — with fewer samples we don't claim
   * to know what's normal for this vendor.
   */
  termsDrift: boolean;
  /**
   * The mode payment terms across the aggregated invoices, or null if
   * none had payment terms recorded. Becomes the vendor's new
   * defaultPaymentTerms once invoiceCount >= VENDOR_PROFILE_READY_THRESHOLD
   * — the caller (recompute-vendor-profile use case) applies that gate.
   */
  modeTerms: string | null;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * @param invoiceRows Approved+exported invoices for one vendor (already
 *   filtered and row-capped by the caller — see
 *   MAX_VENDOR_INVOICE_ROWS in vendor.ts for why the fetch itself is
 *   bounded).
 * @param now Injected so the 30/90-day windows are testable without
 *   depending on the wall clock.
 */
export function aggregateVendorProfile(
  invoiceRows: VendorInvoiceForAggregation[],
  now: Date,
): VendorProfileAggregate {
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);
  const ninetyDaysAgo = new Date(now.getTime() - NINETY_DAYS_MS);

  let totalSum = 0;
  let spend30 = 0;
  let spend90 = 0;
  let latestDate: string | null = null;
  let latestTerms: string | null = null;
  // PR5 — review C5: count payment_terms occurrences so we can derive
  // the MODE rather than treating first-seen as a frozen default.
  const termsCounts = new Map<string, number>();

  for (const r of invoiceRows) {
    const amt = r.total === null ? 0 : Number(r.total);
    totalSum += amt;
    if (r.paymentTerms) {
      termsCounts.set(
        r.paymentTerms,
        (termsCounts.get(r.paymentTerms) ?? 0) + 1,
      );
    }
    if (r.invoiceDate) {
      const d = new Date(`${r.invoiceDate}T00:00:00Z`);
      if (d >= thirtyDaysAgo) spend30 += amt;
      if (d >= ninetyDaysAgo) spend90 += amt;
      if (latestDate === null || r.invoiceDate > latestDate) {
        latestDate = r.invoiceDate;
        latestTerms = r.paymentTerms;
      }
    }
  }

  const invoiceCount = invoiceRows.length;
  const avg = invoiceCount > 0 ? totalSum / invoiceCount : 0;

  let modeTerms: string | null = null;
  let modeCount = 0;
  for (const [terms, count] of termsCounts) {
    if (count > modeCount) {
      modeTerms = terms;
      modeCount = count;
    }
  }
  const termsDrift =
    invoiceCount >= VENDOR_PROFILE_READY_THRESHOLD &&
    Boolean(latestTerms) &&
    Boolean(modeTerms) &&
    latestTerms !== modeTerms;

  return {
    invoiceCount,
    lastInvoiceDate: latestDate,
    spend30d: spend30,
    spend90d: spend90,
    avgInvoiceAmount: avg,
    termsDrift,
    modeTerms,
  };
}
