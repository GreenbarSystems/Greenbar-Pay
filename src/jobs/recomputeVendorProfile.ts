/**
 * recompute-vendor-profile — Phase 7 (D1).
 *
 * Trigger: enqueued by the approve handler after every successful
 * approval.  Idempotent on vendorId: re-running aggregates the same
 * approved invoices and writes the same numbers.
 *
 * Steps:
 *   1. Pull all approved+exported invoices for the vendor.
 *   2. Compute derived stats:
 *        invoice_count, last_invoice_date,
 *        spend_30d, spend_90d, avg_invoice_amount.
 *   3. Detect terms drift: latest approved invoice's payment_terms
 *      vs vendors.default_payment_terms.
 *   4. Increment duplicate_submission_count when the latest approved
 *      invoice has an ACTIVE validation_results row carrying a
 *      duplicate_invoice finding (the dup was approved through anyway).
 *   5. Update vendor_pricing_history: aggregate line items by
 *      normalized item_keyword, upsert avg + samples.
 *   6. Write last_profile_updated.
 *
 * Per-vendor advisory lock prevents two concurrent recomputes from
 * racing on the same vendor.
 */
import type PgBoss from "pg-boss";
import {
  and,
  eq,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import {
  vendors,
  vendorPricingHistory,
  extractedInvoices,
  extractedInvoiceLines,
  validationResults,
  auditEvents,
} from "@/db/schema";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

/** Cap historical samples per (vendor, item_keyword) to keep the math bounded. */
const PRICING_SAMPLE_CAP = 50;

const STOP_WORDS = new Set([
  "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with",
  "service", "services", "fee", "fees", "charge", "charges", "monthly",
  "annual", "quarterly",
]);

export async function handleRecomputeVendorProfile(
  job: PgBoss.Job<JobPayloads[typeof JOB.recomputeVendorProfile]>,
): Promise<void> {
  const { vendorId, organizationId } = job.data;

  await withOrgAsWorker(organizationId, async (tx) => {
    // Serialize per-vendor recomputes.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended('vendor-profile:' || ${vendorId}::text, 0)
      )
    `);

    // Confirm vendor still exists in the org.
    const [vendor] = await tx
      .select({
        id: vendors.id,
        defaultPaymentTerms: vendors.defaultPaymentTerms,
      })
      .from(vendors)
      .where(
        and(
          eq(vendors.id, vendorId),
          eq(vendors.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!vendor) return;

    // 1. Approved (and exported) invoices for this vendor.
    //    We look up by normalized name match — vendor_id isn't set on
    //    extracted_invoices today (Phase 7 adds the link via approve's
    //    bootstrap). For the FIRST recompute of a freshly bootstrapped
    //    vendor we still need to find their invoices; we match on the
    //    aliases the bootstrap wrote.
    // PR5 — review C1: the original join had malformed SQL (one unclosed
    // paren in the nested sql template) AND didn't replicate JS
    // normalizeVendor (no whitespace collapse / trim). Now we use the
    // `normalize_vendor_text(text)` SQL function added in sidecar 0011,
    // which is the single source of truth for normalization in both
    // languages.
    //
    // Match path: invoice's vendor_name normalized === vendor's
    // normalized_name OR is in the vendor's aliases (already stored
    // pre-normalized by bootstrap).
    const invoiceRows = await tx
      .select({
        id: extractedInvoices.id,
        total: extractedInvoices.total,
        invoiceDate: extractedInvoices.invoiceDate,
        paymentTerms: extractedInvoices.paymentTerms,
      })
      .from(extractedInvoices)
      .innerJoin(
        vendors,
        and(
          eq(vendors.id, vendorId),
          or(
            sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ${vendors.normalizedName}`,
            sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ANY(${vendors.aliases})`,
          ),
        ),
      )
      .where(
        and(
          eq(extractedInvoices.organizationId, organizationId),
          inArray(extractedInvoices.reviewStatus, ["approved", "exported"]),
        ),
      );

    if (invoiceRows.length === 0) {
      await tx
        .update(vendors)
        .set({ lastProfileUpdated: sql`now()` })
        .where(eq(vendors.id, vendorId));
      return;
    }

    // 2. Aggregate header-level stats.
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

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

    // PR5 — review C5: terms_drift detection now uses the MODE of
    // payment_terms across all approved invoices, not the first-seen
    // default that was frozen at bootstrap.
    //
    // The mode also becomes the new defaultPaymentTerms, so the
    // "default" reflects what this vendor actually invoices on
    // consistently — once they've drifted to a new terms value
    // permanently, that becomes the new default and drift turns off.
    //
    // Only meaningful at invoice_count >= 3 — matches the
    // vendorWarmingUp gate the risk score uses. With fewer than 3,
    // we don't claim to know what's normal for this vendor.
    let modeTerms: string | null = null;
    let modeCount = 0;
    for (const [terms, count] of termsCounts) {
      if (count > modeCount) {
        modeTerms = terms;
        modeCount = count;
      }
    }
    const termsDrift =
      invoiceCount >= 3 &&
      Boolean(latestTerms) &&
      Boolean(modeTerms) &&
      latestTerms !== modeTerms;

    // PR5 — review C4: duplicate_submission_count semantics.
    //
    // The original query counted active blocking findings on approved
    // invoices — but approve refuses 422 when blocking findings exist,
    // so the counter could never increment. Now: count DISTINCT invoices
    // from this vendor (any review_status, including rejected and
    // superseded) that EVER carried a duplicate_invoice finding. This
    // matches the spec's "duplicate pattern: count and date of prior
    // duplicate SUBMISSION attempts."
    //
    // First we need the full set of this vendor's invoices, not just
    // approved+exported — a rejected duplicate counts toward the pattern.
    const allVendorInvoiceIds = (
      await tx
        .select({ id: extractedInvoices.id })
        .from(extractedInvoices)
        .innerJoin(
          vendors,
          and(
            eq(vendors.id, vendorId),
            or(
              sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ${vendors.normalizedName}`,
              sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ANY(${vendors.aliases})`,
            ),
          ),
        )
        .where(eq(extractedInvoices.organizationId, organizationId))
    ).map((r) => r.id);

    const dupCount =
      allVendorInvoiceIds.length === 0
        ? 0
        : (
            await tx
              .select({
                count: sql<number>`count(distinct ${validationResults.entityId})::int`,
              })
              .from(validationResults)
              .where(
                and(
                  eq(validationResults.organizationId, organizationId),
                  eq(validationResults.entityType, "extracted_invoice"),
                  inArray(validationResults.entityId, allVendorInvoiceIds),
                  sql`${validationResults.errorsJson} @> '[{"code":"duplicate_invoice"}]'::jsonb`,
                ),
              )
          )[0].count;

    await tx
      .update(vendors)
      .set({
        invoiceCount,
        lastInvoiceDate: latestDate,
        spend30d: spend30.toFixed(2),
        spend90d: spend90.toFixed(2),
        avgInvoiceAmount: avg.toFixed(2),
        duplicateSubmissionCount: dupCount,
        termsDriftDetected: termsDrift,
        // PR5 — review C5: defaultPaymentTerms tracks the MODE across
        // approved invoices, not the first-seen value. When a vendor's
        // terms permanently change, the next recompute moves the default
        // to the new mode and termsDrift turns off again. We only
        // update once we have enough samples (≥3) so a single outlier
        // doesn't flip the default.
        ...(invoiceCount >= 3 && modeTerms !== null
          ? { defaultPaymentTerms: modeTerms }
          : {}),
        lastProfileUpdated: sql`now()`,
      })
      .where(eq(vendors.id, vendorId));

    // 5. Pricing history. Aggregate line items by normalized keyword.
    //
    // PR9 — hotfix from cross-reviewer adversarial pass: the previous code
    // referenced an undeclared `invoiceIds` identifier here. The correct
    // scope is the approved/exported invoices already loaded above
    // (invoiceRows); we want pricing history aggregated from the same
    // rows feeding the header stats — never from rejected or superseded
    // invoices. allVendorInvoiceIds (which includes non-approved rows)
    // is reserved for the duplicate-submission tally further down.
    const approvedInvoiceIds = invoiceRows.map((r) => r.id);
    const lineRows = await tx
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
          inArray(extractedInvoiceLines.extractedInvoiceId, approvedInvoiceIds),
        ),
      );

    // Phase 9 — D3: keep the full price series per keyword so we can
    // compute stddev / min / max / last / trend, not just the running
    // average. The series is bounded by PRICING_SAMPLE_CAP per keyword
    // to keep memory predictable on long-tail vendors.
    interface KeywordSeries {
      prices: number[];
      dates: Date[];
      latest: Date;
      latestPrice: number;
    }
    const grouped = new Map<string, KeywordSeries>();
    for (const r of lineRows) {
      if (r.unitPrice === null) continue;
      const keyword = itemKeyword(r.description);
      if (!keyword) continue;
      const price = Number(r.unitPrice);
      if (!Number.isFinite(price)) continue;

      const date = r.invoiceDate
        ? new Date(`${r.invoiceDate}T00:00:00Z`)
        : now;
      const existing = grouped.get(keyword);
      if (existing) {
        existing.prices.push(price);
        existing.dates.push(date);
        if (date > existing.latest) {
          existing.latest = date;
          existing.latestPrice = price;
        }
      } else {
        grouped.set(keyword, {
          prices: [price],
          dates: [date],
          latest: date,
          latestPrice: price,
        });
      }
    }

    // PR6 — review #4: vendor_pricing_history is now append-only. For
    // every (vendor, keyword) computed this run:
    //   1. Soft-supersede the active row (if any) with `superseded_at`.
    //   2. INSERT a fresh row. The partial unique index
    //      `uniq_vendor_pricing_active` enforces at most one active
    //      row per (vendor, keyword).
    // Prior aggregates remain queryable for the rate-drift validation
    // rule and the future evidence packet.
    for (const [keyword, agg] of grouped) {
      // PR10 C3 — bound the per-keyword series at the point we feed it
      // to computeKeywordStats. Previously PRICING_SAMPLE_CAP only
      // bounded the *persisted samples count*; the in-memory arrays
      // grew unbounded with vendor history and the stats sort ran on
      // the full series. Now we keep the most-recent N entries (sorted
      // by invoice date desc, slice, then return to date-asc order so
      // trend math sees the same order as before).
      truncateToMostRecent(agg, PRICING_SAMPLE_CAP);
      const stats = computeKeywordStats(agg);
      const samples = stats.sampleCount; // already capped

      await tx
        .update(vendorPricingHistory)
        .set({ supersededAt: sql`now()` })
        .where(
          and(
            eq(vendorPricingHistory.vendorId, vendorId),
            eq(vendorPricingHistory.itemKeyword, keyword),
            // isNull would be cleaner but we already filter to active
            // via the value comparison.
            sql`${vendorPricingHistory.supersededAt} is null`,
          ),
        );

      await tx
        .insert(vendorPricingHistory)
        .values({
          organizationId,
          vendorId,
          itemKeyword: keyword,
          avgUnitPrice: stats.avg.toFixed(4),
          samples,
          lastSeenAt: agg.latest,
          // Phase 9 — D3 stats. stddev is NULL below 3 samples so the
          // validator treats it as "insufficient data → no drift flag."
          stddevUnitPrice: stats.stddev === null ? null : stats.stddev.toFixed(4),
          minUnitPrice: stats.min.toFixed(4),
          maxUnitPrice: stats.max.toFixed(4),
          lastUnitPrice: stats.lastPrice.toFixed(4),
          priceTrend: stats.trend,
        });
    }

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "vendor.profile_recomputed",
      entityType: "vendor",
      entityId: vendorId,
      metadataJson: {
        invoiceCount,
        spend30d: spend30,
        spend90d: spend90,
        termsDriftDetected: termsDrift,
        duplicateSubmissionCount: dupCount,
        pricingKeywords: grouped.size,
      },
    });
  });
}

/**
 * Phase 9 — D3 per-keyword stats compute. Pure, exported for testing.
 *
 * Trend is bucketed: split the chronologically-ordered price series in
 * thirds, compare the mean of the most-recent third to the mean of the
 * oldest third. > 5% up → rising; > 5% down → falling; else stable.
 * The split-thirds approach is robust to outliers without needing a
 * full regression. Under 3 samples returns `insufficient_data`.
 */
export interface KeywordStatsInput {
  prices: number[];
  dates: Date[];
  latestPrice: number;
}
export interface KeywordStats {
  sampleCount: number;
  avg: number;
  stddev: number | null;
  min: number;
  max: number;
  lastPrice: number;
  trend: "stable" | "rising" | "falling" | "insufficient_data";
}

const TREND_DELTA_THRESHOLD = 0.05;

export function computeKeywordStats(input: KeywordStatsInput): KeywordStats {
  const n = input.prices.length;
  const avg = input.prices.reduce((a, p) => a + p, 0) / n;
  const min = Math.min(...input.prices);
  const max = Math.max(...input.prices);

  // Sample standard deviation (n − 1). NULL when n < 2 — the rate-drift
  // validator treats NULL stddev as "no signal" and skips the finding.
  let stddev: number | null = null;
  if (n >= 2) {
    const variance =
      input.prices.reduce((a, p) => a + (p - avg) ** 2, 0) / (n - 1);
    stddev = Math.sqrt(variance);
  }

  // PR10 M1 — n < 6 is insufficient_data. At n=3-5 the prior split-thirds
  // compared single prices end-to-end (third = max(1, floor(n/3)) = 1),
  // making the trend signal volatile to a single noisy sample. n=6 with
  // third=2 gives two prices per bucket — the minimum that yields a
  // statistically defensible direction.
  let trend: KeywordStats["trend"] = "insufficient_data";
  if (n >= 6) {
    const indexed = input.prices.map((p, i) => ({ p, d: input.dates[i] }));
    indexed.sort((a, b) => a.d.getTime() - b.d.getTime());
    const sorted = indexed.map((x) => x.p);
    const third = Math.max(2, Math.floor(n / 3));
    const oldMean = mean(sorted.slice(0, third));
    const newMean = mean(sorted.slice(-third));
    const delta = oldMean === 0 ? 0 : (newMean - oldMean) / oldMean;
    if (delta > TREND_DELTA_THRESHOLD) trend = "rising";
    else if (delta < -TREND_DELTA_THRESHOLD) trend = "falling";
    else trend = "stable";
  }

  return {
    sampleCount: n,
    avg,
    stddev,
    min,
    max,
    lastPrice: input.latestPrice,
    trend,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, x) => a + x, 0) / xs.length;
}

/**
 * PR10 C3 — trim a keyword series in place to the N most-recent samples
 * by date. Idempotent when the series is already at or under the cap.
 * Mutates the input arrays directly to avoid a copy.
 */
function truncateToMostRecent(
  series: { prices: number[]; dates: Date[] },
  cap: number,
): void {
  if (series.prices.length <= cap) return;
  const indexed = series.prices.map((p, i) => ({ p, d: series.dates[i] }));
  indexed.sort((a, b) => b.d.getTime() - a.d.getTime());
  const kept = indexed.slice(0, cap);
  // Restore date-asc ordering so downstream consumers (e.g. trend math)
  // see the same temporal direction they did pre-truncation.
  kept.sort((a, b) => a.d.getTime() - b.d.getTime());
  series.prices = kept.map((x) => x.p);
  series.dates = kept.map((x) => x.d);
}

/**
 * Reduce a line description to a stable grouping key. Lowercase, strip
 * non-alphanumeric, drop stop words, take first 3 meaningful tokens.
 * Cheap; deterministic; collisions across loosely-related items are
 * acceptable for a Phase 7 first cut.
 */
export function itemKeyword(description: string | null): string | null {
  if (!description) return null;
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  if (tokens.length === 0) return null;
  return tokens.slice(0, 3).join(" ");
}
